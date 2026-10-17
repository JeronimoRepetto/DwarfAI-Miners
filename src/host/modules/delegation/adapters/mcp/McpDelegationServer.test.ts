// L3 (17 §1.3): runDelegationMcpContract over the real McpDelegationServer (16 §4.8, §5.4, §5.7):
// an MCP SDK client calls the two tools through an in-process relay connection that carries one
// JSON-RPC message per frame, as the MCP endpoint hands it over (ADR-013 item 3).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import type { DiagnosticsLog } from '../../../../kernel/ports/diagnosticsLog'
import type { DelegationToken } from '../../ports/delegationStores'
import type {
  DelegationEndpoint,
  DelegationRelayConnection,
  SubtaskResultView
} from '../../ports/delegationServer'
import { runDelegationMcpContract, type ToolAnswer } from '../../testing/delegationMcp.contract'
import {
  DELEGATE_SUBTASK_DESCRIPTION,
  McpDelegationServer,
  SUBTASK_RESULT_DESCRIPTION
} from './McpDelegationServer'
import { NATIVE_SUBAGENT_FALLBACK_SENTENCE } from '../../domain/toolFailure'
import {
  PERMISSION_DENIED_MESSAGE,
  PERMISSION_UNAVAILABLE_MESSAGE,
  type PermissionPromptCall
} from '../../domain/permissionPrompt'
import type { PermissionPromptEndpoint } from '../../ports/permissionPrompt'

/** A relay connection and the client end of it, in process; messages cross on the next tick. */
function relayPair(token: DelegationToken): {
  connection: DelegationRelayConnection
  client: Transport
  frames: unknown[]
} {
  const toServer: Array<(m: unknown) => void> = []
  const closeListeners: Array<() => void> = []
  const frames: unknown[] = []
  let closed = false
  const client: Transport = {
    start: () => Promise.resolve(),
    send: (message) => {
      if (!closed) queueMicrotask(() => toServer.forEach((l) => l(structuredClone(message))))
      return Promise.resolve()
    },
    close: () => {
      connection.close()
      return Promise.resolve()
    }
  }
  const connection: DelegationRelayConnection = {
    token,
    send: (message) => {
      frames.push(message)
      if (!closed)
        queueMicrotask(() => client.onmessage?.(structuredClone(message) as JSONRPCMessage))
    },
    onMessage: (listener) => toServer.push(listener),
    onClose: (listener) => closeListeners.push(listener),
    close: () => {
      if (closed) return
      closed = true
      closeListeners.splice(0).forEach((l) => l())
      client.onclose?.()
    }
  }
  return { connection, client, frames }
}

async function connectedClient(
  handler: DelegationEndpoint,
  token: DelegationToken,
  log: DiagnosticsLog = new RecordingDiagnosticsLog(),
  prompts?: PermissionPromptEndpoint
) {
  const pair = relayPair(token)
  let close: () => Promise<void> = () => Promise.resolve()
  const server = new McpDelegationServer(
    {
      listen: (accept) => {
        accept(pair.connection)
        close = () => Promise.resolve()
        return Promise.resolve({ endpoint: { path: 'in-process' }, close: () => close() })
      }
    },
    log,
    prompts
  )
  await server.listen(handler)
  const client = new Client({ name: 'relay-under-test', version: '1.0.0' })
  await client.connect(pair.client)
  return { client, server, frames: pair.frames }
}

function answerOf(result: CallToolResult): ToolAnswer {
  const view = result.structuredContent as SubtaskResultView
  // The text block carries the same shape, for a client that reads only text.
  const text = result.content[0]
  expect(text?.type === 'text' ? JSON.parse(text.text) : null).toEqual(view)
  return { view, isError: result.isError === true }
}

runDelegationMcpContract('McpDelegationServer', async (handler, token, log) => {
  const { client, server } = await connectedClient(handler, token, log)
  return {
    caller: {
      delegateSubtask: async (args) =>
        answerOf(
          (await client.callTool({ name: 'delegate_subtask', arguments: args })) as CallToolResult
        ),
      subtaskResult: async (args) =>
        answerOf(
          (await client.callTool({ name: 'subtask_result', arguments: args })) as CallToolResult
        )
    },
    dispose: async () => {
      await client.close()
      await server.close()
    }
  }
})

describe('McpDelegationServer (16 §5.4)', () => {
  const token: DelegationToken = {
    launchId: '01890a5d-ac96-774b-bcce-b302099a8a01' as DelegationToken['launchId'],
    parentDwarfId: null,
    mechanism: 'ticket-file',
    issuedAt: 0
  }
  const never: DelegationEndpoint = {
    delegate: () => new Promise(() => {}),
    result: () => new Promise(() => {})
  }

  // AMENDED by AMENDMENT-21 (owner, 2026-10-17; 16 §5.4 now lists three tools): was "exactly the
  // two tools are listed". A connection whose launch is not an owned Claude stream-json session
  // still gets exactly the two; the third, `permission`, is the next case's.
  it('[ADR-013] a connection that is not an owned stream-json session lists exactly the two delegation tools, with their bounds and the fallback sentence in both descriptions', async () => {
    const { client, server } = await connectedClient(never, token, undefined, promptsFor(null))

    const { tools } = await client.listTools()

    expect(tools.map((t) => t.name)).toEqual(['delegate_subtask', 'subtask_result'])
    const [delegate, result] = tools
    // AMENDED for the ISSUE-199 security correction (was: `minLength`/`maxLength` in the schema):
    // a JSON-schema length counts UTF-16 units and its refusal is the SDK's `isError`, so the
    // bounds are stated in the descriptions and enforced in code points by `SubtaskText`.
    const properties = delegate?.inputSchema.properties as Record<string, Record<string, unknown>>
    expect(properties).toMatchObject({ task: { type: 'string' }, context: { type: 'string' } })
    expect(properties['task']?.['description']).toContain('At most 4000 characters')
    expect(properties['context']?.['description']).toContain('At most 16000 characters')
    expect(JSON.stringify(delegate?.inputSchema)).not.toMatch(/minLength|maxLength/)
    expect(delegate?.inputSchema.required).toEqual(['task'])
    expect(result?.inputSchema.properties).toMatchObject({ ticket: { type: 'string' } })
    for (const description of [DELEGATE_SUBTASK_DESCRIPTION, SUBTASK_RESULT_DESCRIPTION]) {
      expect(description.endsWith(NATIVE_SUBAGENT_FALLBACK_SENTENCE)).toBe(true)
    }
    await client.close()
    await server.close()
  })

  it('[ADR-013] each message leaves as one frame: one JSON-RPC response object per request', async () => {
    const { client, server, frames } = await connectedClient(never, token)
    const before = frames.length

    await client.listTools()

    expect(frames.length - before).toBe(1)
    expect(frames.at(-1)).toMatchObject({ jsonrpc: '2.0', result: { tools: expect.any(Array) } })
    await client.close()
    await server.close()
  })
})

/**
 * A PermissionPromptEndpoint that serves `owned` only (null: none) and answers with `decide`;
 * every call it was asked, with its token's launch and its signal, is recorded.
 */
function promptsFor(
  owned: DelegationToken['launchId'] | null,
  decide: (call: PermissionPromptCall, signal: AbortSignal) => Promise<'allow' | 'deny'> = () =>
    Promise.resolve('allow')
): PermissionPromptEndpoint & {
  asked: Array<{ launchId: string; call: PermissionPromptCall; signal: AbortSignal }>
} {
  const asked: Array<{ launchId: string; call: PermissionPromptCall; signal: AbortSignal }> = []
  return {
    asked,
    serves: (t) => owned !== null && t.launchId === owned,
    decide: (t, call, signal) => {
      asked.push({ launchId: t.launchId, call, signal })
      return decide(call, signal)
    }
  }
}

/** The SP-08 recording's prompt-tool call (fixtures/claude/stream-json/2.1.x/sp08-allow-mcp.jsonl). */
const PROMPT = {
  tool_name: 'Write',
  input: { file_path: '<REPO>\sp08-allow-marker.txt', content: 'marker' },
  tool_use_id: '00000000-0000-4000-8000-000000000001'
}

/** The one text block of a prompt-tool result, parsed: Claude reads the answer from it. */
function promptReplyOf(result: CallToolResult): unknown {
  expect(result.isError === true).toBe(false)
  expect(result.content).toHaveLength(1)
  const text = result.content[0]
  return text?.type === 'text' ? JSON.parse(text.text) : null
}

describe('McpDelegationServer permission tool (AMENDMENT-21, 16 §5.4, 15 §2.7)', () => {
  const owned: DelegationToken = {
    launchId: '01890a5d-ac96-774b-bcce-b302099a8a01' as DelegationToken['launchId'],
    parentDwarfId: null,
    mechanism: 'ticket-file',
    issuedAt: 0
  }
  const other: DelegationToken = {
    ...owned,
    launchId: '01890a5d-ac96-774b-bcce-b302099a8a02' as DelegationToken['launchId']
  }
  const never: DelegationEndpoint = {
    delegate: () => new Promise(() => {}),
    result: () => new Promise(() => {})
  }

  it('[ADR-013] an owned stream-json session connection lists three tools: the two delegation tools and permission', async () => {
    const { client, server } = await connectedClient(
      never,
      owned,
      undefined,
      promptsFor(owned.launchId)
    )

    const { tools } = await client.listTools()

    expect(tools.map((t) => t.name)).toEqual(['delegate_subtask', 'subtask_result', 'permission'])
    const permission = tools[2]
    expect(Object.keys(permission?.inputSchema.properties ?? {})).toEqual([
      'tool_name',
      'input',
      'tool_use_id'
    ])
    await client.close()
    await server.close()
  })

  it('[ADR-010] the session Allow answers behavior allow with updatedInput, the call reaching its own launch only', async () => {
    const prompts = promptsFor(owned.launchId)
    const { client, server } = await connectedClient(never, owned, undefined, prompts)

    const result = (await client.callTool({
      name: 'permission',
      arguments: PROMPT
    })) as CallToolResult

    expect(promptReplyOf(result)).toEqual({ behavior: 'allow', updatedInput: PROMPT.input })
    expect(prompts.asked.map((a) => [a.launchId, a.call])).toEqual([
      [owned.launchId, { toolName: 'Write', input: PROMPT.input, toolUseId: PROMPT.tool_use_id }]
    ])
    await client.close()
    await server.close()
  })

  it('[ADR-010] the session Deny answers behavior deny with a message', async () => {
    const prompts = promptsFor(owned.launchId, () => Promise.resolve('deny'))
    const { client, server } = await connectedClient(never, owned, undefined, prompts)

    const result = (await client.callTool({
      name: 'permission',
      arguments: PROMPT
    })) as CallToolResult

    expect(promptReplyOf(result)).toEqual({ behavior: 'deny', message: PERMISSION_DENIED_MESSAGE })
    await client.close()
    await server.close()
  })

  it('[ADR-010] a bridge error and a malformed call both answer deny, never an MCP error', async () => {
    const prompts = promptsFor(owned.launchId, () => Promise.reject(new Error('bridge down')))
    const { client, server } = await connectedClient(never, owned, undefined, prompts)

    const failed = (await client.callTool({
      name: 'permission',
      arguments: PROMPT
    })) as CallToolResult
    const malformed = (await client.callTool({
      name: 'permission',
      arguments: { tool_name: 'Write', input: 'not an object' }
    })) as CallToolResult

    const unavailable = { behavior: 'deny', message: PERMISSION_UNAVAILABLE_MESSAGE }
    expect(promptReplyOf(failed)).toEqual(unavailable)
    expect(promptReplyOf(malformed)).toEqual(unavailable)
    expect(prompts.asked).toHaveLength(1)
    await client.close()
    await server.close()
  })

  it('[ADR-013] another session credential gets no permission tool, and a call to it reaches no session', async () => {
    const prompts = promptsFor(owned.launchId)
    const { client, server } = await connectedClient(never, other, undefined, prompts)

    const { tools } = await client.listTools()
    const refused = await client.callTool({ name: 'permission', arguments: PROMPT }).then(
      (result) => (result as CallToolResult).isError === true,
      () => true
    )

    expect(tools.map((t) => t.name)).not.toContain('permission')
    expect(refused).toBe(true)
    expect(prompts.asked).toEqual([])
    await client.close()
    await server.close()
  })

  it('[ADR-010] a cancelled tool call aborts the signal handed to the session', async () => {
    let resolve: (decision: 'allow' | 'deny') => void = () => {}
    const prompts = promptsFor(owned.launchId, () => new Promise((settle) => (resolve = settle)))
    const { client, server } = await connectedClient(never, owned, undefined, prompts)
    const abort = new AbortController()

    const call = client.callTool({ name: 'permission', arguments: PROMPT }, undefined, {
      signal: abort.signal
    })
    for (let i = 0; i < 20 && prompts.asked.length === 0; i += 1) {
      await new Promise((tick) => setImmediate(tick))
    }
    abort.abort()
    await call.catch(() => undefined)
    for (let i = 0; i < 20; i += 1) await new Promise((tick) => setImmediate(tick))

    expect(prompts.asked[0]?.signal.aborted).toBe(true)
    resolve('allow')
    await client.close()
    await server.close()
  })
})
