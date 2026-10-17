// `McpDelegationServer` (16 §4.8 adapter of `DelegationServer`; §5.4, §5.5; ADR-013 items 1, 3): the
// Jev delegation MCP server, served by the Host over the MCP endpoint's frames.
//
// - `listen(handler)` asks the MCP endpoint (a `DelegationRelayListener`, host/transport/mcpEndpoint)
//   to bind; every authenticated relay connection gets its own MCP server over a frame transport:
//   one MCP JSON-RPC message per frame, unchanged (ADR-013 item 3). The connection's bound token is
//   the first argument of every `DelegationEndpoint` call; the server never sees a credential.
// - The two delegation tools, `delegate_subtask` (`task` 1..4 000 characters, `context` ≤ 16 000, 06
//   `SubtaskText`) and `subtask_result` (`ticket`). The schemas type the arguments only: the
//   bounds are counted in code points by `SubtaskText` (09 §4.6), and an out-of-bound input is a
//   tool failure with the fallback sentence. A zod `.min`/`.max` would count UTF-16 units and
//   turn a refusal into the SDK's `isError` answer, which carries no fallback sentence. `delegate_subtask` calls `delegate`,
//   which answers a ticket at once, then `result(…, { maxMs: DELEGATION_WAIT_MS })`, which waits
//   in the Host (16 §5.5): no polling loop here.
// - One tool-result shape (16 §5.4) as structured content and as one JSON text block, for a client
//   that reads only text. A delegation failure is that shape with `status: 'failed'`: `isError` is
//   never set for it (`jevMcpServerCore.ts:40` at `0bfd108`, kept).
// - A third tool, `permission` (AMENDMENT-21, owner-approved 2026-10-17; 16 §5.4 lists three tools),
//   only on a connection whose bound token's launch is an owned Claude `stream-json` session
//   (`PermissionPromptEndpoint.serves`, read once when the connection is accepted): Claude's
//   `--permission-prompt-tool mcp__dwarfai__permission`. Its input and answer are Claude's shape
//   (15 §2.7, `answerPermissionPrompt`): the answer is one JSON text block, and every failure is a
//   deny, never `isError`. Its schema types nothing (each field `unknown`), so a malformed call
//   reaches the fail-closed reader instead of the SDK's `isError` refusal. Any other connection
//   (another launch's credential, a driver without the prompt tool) never sees the tool, and a
//   call to it is the SDK's unknown-tool refusal. A cancelled call aborts the signal it hands on.
// - A closed relay never cancels anything (16 §5.5): the ticket stays readable by a new relay of
//   the same launch. `close` stops the endpoint and ends every relay connection.
//
// Candidate (21 §6): `src/main/mcp/jevMcpServerCore.ts` adapted — its two-tool registration, input
// schemas, descriptions and result shape kept; its HTTP `DelegationLink` and the `link-*` failure
// kinds replaced by the `DelegationEndpoint` port (16 §5.1). The SDK is used only here (R11).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { DiagnosticsLog } from '../../../../kernel/ports/diagnosticsLog'
import { answerDelegateSubtask, answerSubtaskResult } from '../../application/delegationEndpoint'
import { answerPermissionPrompt } from '../../application/permissionPrompt'
import type { PermissionPromptReply } from '../../domain/permissionPrompt'
import { MAX_DELEGATION_CONTEXT_CHARS, MAX_DELEGATION_TASK_CHARS } from '../../domain/subtaskText'
import { NATIVE_SUBAGENT_FALLBACK_SENTENCE } from '../../domain/toolFailure'
import {
  DELEGATION_WAIT_MS,
  type DelegationEndpoint,
  type DelegationRelayConnection,
  type DelegationRelayListener,
  type DelegationServer,
  type LoopbackEndpoint,
  type SubtaskResultView
} from '../../ports/delegationServer'
import type { PermissionPromptEndpoint } from '../../ports/permissionPrompt'

export const DELEGATE_SUBTASK_TOOL_NAME = 'delegate_subtask'
export const SUBTASK_RESULT_TOOL_NAME = 'subtask_result'
/** Claude's prompt tool, `mcp__dwarfai__permission` under the Claude relay entry (15 §4.2). */
export const PERMISSION_TOOL_NAME = 'permission'

/** Read by the model only (Claude's `--permission-prompt-tool` is never offered to it as a tool). */
export const PERMISSION_DESCRIPTION =
  'Asks the person in DwarfAI-Miners whether a tool use may run. Answers allow, with the input ' +
  'unchanged as updatedInput, or deny with a message.'

const SERVER_INFO = { name: 'dwarfai-miners-jev-delegation', version: '1.0.0' } as const

const TOOL_DESCRIPTION_PREFACE =
  'Hands a subtask to the DwarfAI-Miners panel, which asks Jev (TypeSafe) which provider, ' +
  'model and effort suit it and runs the subtask as its own session in the same mine.'

/** Kept from `jevMcpServerCore.ts` at `0bfd108`; ends with the fallback sentence (16 §5.4). */
export const DELEGATE_SUBTASK_DESCRIPTION =
  `${TOOL_DESCRIPTION_PREFACE} Use it for a self-contained subtask you would otherwise give a ` +
  `subagent. The child starts fresh: its whole prompt is \`context\` followed by \`task\`, and it ` +
  `never sees this conversation. Blocks until the child session concludes or the wait budget is ` +
  `spent. A \`done\` answer carries the child's last turn as \`outcome\`: \`kind\` is \`concluded\`, ` +
  `\`capped\`, \`errored\` or \`interrupted\`, and \`text\` is present only when the provider ` +
  `returned one (\`truncated\` marks a cut). A \`pending\` answer means the child is still running — call ${SUBTASK_RESULT_TOOL_NAME} ` +
  `with its \`ticket\` later to fetch the result. On any \`failed\` answer, ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}`

/** Kept from `jevMcpServerCore.ts` at `0bfd108`; ends with the fallback sentence (16 §5.4). */
export const SUBTASK_RESULT_DESCRIPTION =
  `Fetches the result of a subtask started with ${DELEGATE_SUBTASK_TOOL_NAME}, by its \`ticket\`. ` +
  `Answers in the same shape as ${DELEGATE_SUBTASK_TOOL_NAME}: \`done\` with the child's \`outcome\`, ` +
  `\`pending\` if the child has not concluded yet, or \`failed\` (an unknown ticket is one). On any \`failed\` ` +
  `answer, ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}`

export class McpDelegationServer implements DelegationServer {
  private stop: (() => Promise<void>) | null = null
  private readonly relays = new Set<DelegationRelayConnection>()

  constructor(
    private readonly listener: DelegationRelayListener,
    private readonly log: DiagnosticsLog,
    /** Absent: no connection is served the `permission` tool. */
    private readonly prompts?: PermissionPromptEndpoint
  ) {}

  async listen(handler: DelegationEndpoint): Promise<{ endpoint: LoopbackEndpoint }> {
    const bound = await this.listener.listen((connection) => {
      this.relays.add(connection)
      connection.onClose(() => this.relays.delete(connection))
      void serveRelay(connection, handler, this.log, this.prompts)
    })
    this.stop = bound.close
    return { endpoint: bound.endpoint }
  }

  async close(): Promise<void> {
    for (const relay of [...this.relays]) relay.close()
    this.relays.clear()
    const stop = this.stop
    this.stop = null
    await stop?.()
  }
}

/** One MCP server for one authenticated relay connection. */
export async function serveRelay(
  connection: DelegationRelayConnection,
  handler: DelegationEndpoint,
  log: DiagnosticsLog,
  prompts?: PermissionPromptEndpoint
): Promise<void> {
  const server = createDelegationMcpServer(connection, handler, log, prompts)
  await server.connect(new FrameTransport(connection))
}

function createDelegationMcpServer(
  connection: DelegationRelayConnection,
  handler: DelegationEndpoint,
  log: DiagnosticsLog,
  prompts?: PermissionPromptEndpoint
): McpServer {
  const server = new McpServer(SERVER_INFO)
  server.registerTool(
    DELEGATE_SUBTASK_TOOL_NAME,
    {
      title: 'Delegate a subtask through Jev',
      description: DELEGATE_SUBTASK_DESCRIPTION,
      inputSchema: {
        task: z
          .string()
          .describe(
            `What the child session should do, written to stand alone: the child never sees this conversation. At most ${MAX_DELEGATION_TASK_CHARS} characters.`
          ),
        context: z
          .string()
          .optional()
          .describe(
            `Background the child needs (file paths, decisions, constraints), placed before task in its prompt. At most ${MAX_DELEGATION_CONTEXT_CHARS} characters.`
          )
      }
    },
    async (args) =>
      toCallToolResult(
        await answerDelegateSubtask(
          handler,
          connection.token,
          args.context === undefined
            ? { task: args.task }
            : { task: args.task, context: args.context },
          DELEGATION_WAIT_MS,
          log
        )
      )
  )
  server.registerTool(
    SUBTASK_RESULT_TOOL_NAME,
    {
      title: 'Fetch a delegated subtask’s result',
      description: SUBTASK_RESULT_DESCRIPTION,
      inputSchema: {
        ticket: z
          .string()
          .describe(`The ticket a pending ${DELEGATE_SUBTASK_TOOL_NAME} answer returned.`)
      }
    },
    async (args) =>
      toCallToolResult(
        await answerSubtaskResult(handler, connection.token, args.ticket, DELEGATION_WAIT_MS, log)
      )
  )
  if (prompts !== undefined && prompts.serves(connection.token)) {
    server.registerTool(
      PERMISSION_TOOL_NAME,
      {
        title: 'Ask the person about a tool use',
        description: PERMISSION_DESCRIPTION,
        inputSchema: {
          tool_name: z.unknown().describe('The tool Claude wants to run.'),
          input: z.unknown().describe('The input it wants to run the tool with.'),
          tool_use_id: z.unknown().describe('The id of the tool use block.')
        }
      },
      async (args, extra) =>
        toPromptResult(
          await answerPermissionPrompt(prompts, connection.token, args, extra.signal, log)
        )
    )
  }
  return server
}

/** Claude reads the prompt tool's answer from its one JSON text block (15 §2.7). */
function toPromptResult(reply: PermissionPromptReply): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(reply) }] }
}

/** The one shape, structured and as text; never `isError` (16 §5.4). */
function toCallToolResult(view: SubtaskResultView): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(view) }], structuredContent: { ...view } }
}

/** The MCP SDK transport over one relay connection: one JSON-RPC message per frame. */
class FrameTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T) => void

  constructor(private readonly connection: DelegationRelayConnection) {}

  start(): Promise<void> {
    this.connection.onMessage((message) => this.onmessage?.(message as JSONRPCMessage))
    this.connection.onClose(() => this.onclose?.())
    return Promise.resolve()
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.connection.send(message)
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.connection.close()
    return Promise.resolve()
  }
}
