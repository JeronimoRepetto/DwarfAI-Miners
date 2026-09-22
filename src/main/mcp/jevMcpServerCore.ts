import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { DelegationLink } from './delegationLink'
import {
  DELEGATE_SUBTASK_TOOL_NAME,
  MAX_DELEGATION_CONTEXT_CHARS,
  MAX_DELEGATION_TASK_CHARS,
  NATIVE_SUBAGENT_FALLBACK_SENTENCE,
  SUBTASK_RESULT_TOOL_NAME,
  type DelegationToolResult,
  delegationFailure
} from './delegationProtocol'

/**
 * The stdio MCP server this app injects into a launched session (#511),
 * factored out from the entry point (jevMcpServer.ts) so it can be proven
 * over `InMemoryTransport.createLinkedPair()` with no child process, no
 * stdin/stdout, and no real network — only a hand-written `DelegationLink`
 * fake (jevMcpServerCore.test.ts).
 *
 * Registers exactly two tools and decides nothing about routing, launching
 * or limits — see `delegationLink.ts` for the loopback client and T3's own
 * delegation service (main-side) for what actually answers it.
 */

const SERVER_INFO = { name: 'dwarfai-miners-jev-delegation', version: '1.0.0' } as const

export interface JevMcpServerOptions {
  /** `undefined` when this launch's env carried no (or a malformed) delegation endpoint/token. */
  link: DelegationLink | undefined
  /** How long `delegate_subtask` may block before answering `pending` — `DelegationLinkEnv.waitMs` or the protocol default. */
  waitMs: number
}

/**
 * Every tool call answers with the SAME typed shape, as structured content
 * (for a client that reads it) AND as a JSON text block (for one that only
 * reads text, per the feature document's own instruction) — never
 * `isError`, since a delegation failure is not a PROTOCOL error, it is an
 * ordinary, fully-typed answer the agent is expected to read and act on.
 */
function toCallToolResult(result: DelegationToolResult): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    // Spread into a fresh object literal rather than passed as-is: a plain
    // union type has no index signature of its own, and only a fresh
    // literal is checked structurally against `Record<string, unknown>`.
    structuredContent: { ...result }
  }
}

function unconfiguredResult(): DelegationToolResult {
  return {
    status: 'failed',
    failure: delegationFailure(
      'link-unconfigured',
      'This session was not given a delegation endpoint.'
    )
  }
}

const TOOL_DESCRIPTION_PREFACE =
  'Hands a subtask to the DwarfAI-Miners panel, which asks Jev (TypeSafe) which provider, ' +
  'model and effort suit it and runs the subtask as its own session in the same mine.'

const DELEGATE_SUBTASK_DESCRIPTION =
  `${TOOL_DESCRIPTION_PREFACE} Blocks until the child session concludes or the wait budget is ` +
  `spent. A \`pending\` answer means the child is still running — call ${SUBTASK_RESULT_TOOL_NAME} ` +
  `with its \`ticket\` later to fetch the result. On any \`failed\` answer, ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}`

const SUBTASK_RESULT_DESCRIPTION =
  `Fetches the result of a subtask started with ${DELEGATE_SUBTASK_TOOL_NAME}, by its \`ticket\`. ` +
  `May itself still answer \`pending\` if the child has not concluded yet. On any \`failed\` ` +
  `answer, ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}`

export function createJevMcpServer(options: JevMcpServerOptions): McpServer {
  const { link, waitMs } = options
  const server = new McpServer(SERVER_INFO)

  server.registerTool(
    DELEGATE_SUBTASK_TOOL_NAME,
    {
      title: 'Delegate a subtask through Jev',
      description: DELEGATE_SUBTASK_DESCRIPTION,
      inputSchema: {
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
      }
    },
    async (args) => {
      if (link === undefined) return toCallToolResult(unconfiguredResult())
      return toCallToolResult(await link.delegate(args.task, args.context, { waitMs }))
    }
  )

  server.registerTool(
    SUBTASK_RESULT_TOOL_NAME,
    {
      title: 'Fetch a delegated subtask’s result',
      description: SUBTASK_RESULT_DESCRIPTION,
      inputSchema: {
        ticket: z.string().min(1, 'ticket must not be empty')
      }
    },
    async (args) => {
      if (link === undefined) return toCallToolResult(unconfiguredResult())
      return toCallToolResult(await link.result(args.ticket))
    }
  )

  return server
}
