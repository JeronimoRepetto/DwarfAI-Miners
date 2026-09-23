import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { DelegationLink } from './delegationLink'
import type { DelegationToolResult } from './delegationProtocol'
import { DELEGATION_SERVER_NAME } from './delegationInjection'
import {
  DELEGATE_SUBTASK_TOOL_NAME,
  formatDelegationResultText,
  MAX_DELEGATION_CONTEXT_CHARS,
  MAX_DELEGATION_TASK_CHARS,
  NATIVE_SUBAGENT_FALLBACK_SENTENCE,
  SUBTASK_RESULT_TOOL_NAME
} from './delegationServerProtocol'

/**
 * A held Claude session's own in-process delegation server (#511 M1a) — the
 * SAME two tools `jevMcpServerCore.ts` registers over stdio for a detached
 * `claude -p`/OpenCode launch, built here instead as an Agent SDK IN-PROCESS
 * server (`createSdkMcpServer`/`tool`, verified against the installed
 * `@anthropic-ai/claude-agent-sdk`'s own `sdk.d.ts`) for a HELD session.
 *
 * ## Why this exists at all: the argv-exposure finding, and its evidence
 *
 * The Agent SDK turns a `type: 'stdio'` `mcpServers` entry (what
 * `claudeHeldMcpServers` in `delegationInjection.ts` used to hand a held
 * session) into `--mcp-config <inline JSON>` on the CLASSIC `claude`
 * process's own command line — `sdk.mjs`'s `ProcessTransport.initialize`
 * reads `mcpServers` off its own options and, when any are present, does
 * `Z.push("--mcp-config", me({mcpServers:K}))` (`me` is `JSON.stringify`).
 * That JSON carries this launch's endpoint AND token, on the argv any local
 * user can read with `ps`/Task Manager on a shared machine.
 *
 * A `type: 'sdk'` entry — exactly what `createSdkMcpServer` returns — is
 * filtered OUT of that argv build before it ever runs. Traced in the same
 * installed `sdk.mjs`: the function that assembles a query's options splits
 * `mcpServers` with `for (let [fr,so] of Object.entries(NL)) if
 * (so.type==="sdk" && so.instance) GL.set(fr,so); else KL[fr]=so`, then
 * constructs the `ProcessTransport` with `mcpServers: KL` (non-`sdk` entries
 * only — this is the `K` the argv build above reads) while `GL` (the `Map`
 * of `sdk`-type entries) is handed to the `Query` object as a SEPARATE
 * constructor argument, connected over the query's own control channel
 * (`connectSdkMcpServer`, the same method `Query.setMcpServers` calls at
 * runtime) — never through `ProcessTransport`, never through argv. So this
 * server carries no secret on the CLI's command line either way: a `type:
 * 'sdk'` config never reaches the code path that builds `--mcp-config` at
 * all, and its tool handlers below run as plain in-process function calls,
 * with no endpoint, no token and no env of their own to expose.
 * `delegationHeldServer.test.ts` pins the exact excerpt this comment
 * describes, so a future SDK upgrade that changes this split fails loudly
 * rather than silently regressing back to the exposed shape.
 *
 * ## Why this duplicates jevMcpServerCore.ts's wording instead of importing it
 *
 * `jevMcpServerCore.ts` is a runtime dependency of `jevMcpServer.js`'s own
 * build graph (the standalone stdio entry `electron.vite.config.ts` bundles
 * self-contained) — it imports RUNTIME values from `delegationProtocol.ts`.
 * This module is a runtime dependency of `index.js`'s graph instead. If this
 * module imported `jevMcpServerCore.ts` (or anything importing
 * `delegationProtocol.ts` at runtime), `delegationProtocol.ts` would become
 * reachable from BOTH build graphs — the EXACT regression
 * `delegationServerProtocol.ts`'s own top comment already documents fixing
 * twice for other symbols (`delegationInjection.ts`, `delegationService.ts`).
 * So the tool NAMES, char limits and fallback sentence are read from
 * `delegationServerProtocol.ts` (the safe, main-only twin those two modules
 * already use), and the DESCRIPTIONS below are a small, deliberate
 * duplication of `jevMcpServerCore.ts`'s own wording — pinned equal by
 * `delegationHeldServer.test.ts`'s own drift guard, the same discipline
 * `delegationServerProtocol.test.ts` already holds for its own twin values.
 * Only the TYPES `DelegationLink`/`DelegationToolResult` cross via `import
 * type`, fully erased at build time, so neither carries a runtime edge.
 */

const TOOL_DESCRIPTION_PREFACE =
  'Hands a subtask to the DwarfAI-Miners panel, which asks Jev (TypeSafe) which provider, ' +
  'model and effort suit it and runs the subtask as its own session in the same mine.'

/**
 * Duplicated from jevMcpServerCore.ts — see this module's own top comment
 * for why. EXPORTED so `delegationHeldServer.test.ts` can pin this equal to
 * `jevMcpServerCore.ts`'s own copy, the same drift-guard shape
 * `delegationServerProtocol.test.ts` already holds for its own twin values.
 */
export const DELEGATE_SUBTASK_DESCRIPTION =
  `${TOOL_DESCRIPTION_PREFACE} Blocks until the child session concludes or the wait budget is ` +
  `spent. A \`pending\` answer means the child is still running — call ${SUBTASK_RESULT_TOOL_NAME} ` +
  `with its \`ticket\` later to fetch the result. On any \`failed\` answer, ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}`

/** Duplicated from jevMcpServerCore.ts — see this module's own top comment for why. */
export const SUBTASK_RESULT_DESCRIPTION =
  `Fetches the result of a subtask started with ${DELEGATE_SUBTASK_TOOL_NAME}, by its \`ticket\`. ` +
  `May itself still answer \`pending\` if the child has not concluded yet. On any \`failed\` ` +
  `answer, ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}`

/**
 * Same shape `jevMcpServerCore.ts`'s own `toCallToolResult` builds — see that
 * function's own comment: never `isError`, since a delegation failure is an
 * ordinary, fully-typed answer the agent is expected to read and act on,
 * never a protocol error.
 */
function toCallToolResult(result: DelegationToolResult): CallToolResult {
  return {
    content: [{ type: 'text', text: formatDelegationResultText(result) }],
    structuredContent: { ...result }
  }
}

export interface HeldDelegationLink {
  link: DelegationLink
  waitMs: number
}

/**
 * Build the in-process `mcpServers` entry a held Claude session registers
 * (#511 M1a) — `type: 'sdk'`, so it never reaches the CLI's own argv (see
 * this module's top comment). Reused for exactly one launch's own `query()`
 * options; a fresh one is built per launch, mirroring `claudeHeldMcpServers`'
 * own per-launch construction.
 */
export function createHeldDelegationMcpServer(
  held: HeldDelegationLink
): McpSdkServerConfigWithInstance {
  const { link, waitMs } = held
  return createSdkMcpServer({
    name: DELEGATION_SERVER_NAME,
    tools: [
      tool(
        DELEGATE_SUBTASK_TOOL_NAME,
        DELEGATE_SUBTASK_DESCRIPTION,
        {
          task: z
            .string()
            .min(1, 'task must not be empty')
            .max(
              MAX_DELEGATION_TASK_CHARS,
              `task must be at most ${MAX_DELEGATION_TASK_CHARS} characters`
            ),
          context: z
            .string()
            .max(
              MAX_DELEGATION_CONTEXT_CHARS,
              `context must be at most ${MAX_DELEGATION_CONTEXT_CHARS} characters`
            )
            .optional()
        },
        async (args) => toCallToolResult(await link.delegate(args.task, args.context, { waitMs }))
      ),
      tool(
        SUBTASK_RESULT_TOOL_NAME,
        SUBTASK_RESULT_DESCRIPTION,
        { ticket: z.string().min(1, 'ticket must not be empty') },
        async (args) => toCallToolResult(await link.result(args.ticket))
      )
    ]
  })
}
