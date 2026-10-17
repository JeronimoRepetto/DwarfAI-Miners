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
  log: DiagnosticsLog = new RecordingDiagnosticsLog()
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
    log
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

  it('[ADR-013] exactly the two tools are listed, with their bounds and the fallback sentence in both descriptions', async () => {
    const { client, server } = await connectedClient(never, token)

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

describe('McpDelegationServer flush report (ISSUE-205; 16 §5.4 "Handoff")', () => {
  const token: DelegationToken = {
    launchId: '01890a5d-ac96-774b-bcce-b302099a8a05' as DelegationToken['launchId'],
    parentDwarfId: null,
    mechanism: 'ticket-file',
    issuedAt: 0
  }

  /** A server over one in-process relay, reporting each done answer's flush. */
  async function reporting(result: (close: () => void) => SubtaskResultView) {
    const pair = relayPair(token)
    const reports: Array<{ answer: SubtaskResultView; flushed: boolean; framesSent: number }> = []
    const handler: DelegationEndpoint = {
      delegate: () => Promise.resolve({ ok: true, value: { ticket: 'ticket-205' } }),
      result: () => Promise.resolve(result(() => pair.connection.close()))
    }
    const server = new McpDelegationServer(
      {
        listen: (accept) => {
          accept(pair.connection)
          return Promise.resolve({
            endpoint: { path: 'in-process' },
            close: () => Promise.resolve()
          })
        }
      },
      new RecordingDiagnosticsLog(),
      {
        responseFlushed: (answer, flushed) =>
          reports.push({ answer, flushed, framesSent: pair.frames.length })
      }
    )
    await server.listen(handler)
    const client = new Client({ name: 'relay-under-test', version: '1.0.0' })
    await client.connect(pair.client)
    return { client, server, reports, frames: pair.frames }
  }

  it('[S8.08, INV-68] a done answer is reported flushed once its response frame left on the open connection', async () => {
    const done: SubtaskResultView = { status: 'done', outcome: { kind: 'concluded', text: 'ok' } }
    const s = await reporting(() => done)

    await s.client.callTool({ name: 'subtask_result', arguments: { ticket: 'ticket-205' } })
    await s.client.callTool({ name: 'delegate_subtask', arguments: { task: 'Map the shafts' } })

    expect(s.reports.map((r) => [r.answer, r.flushed])).toStrictEqual([
      [done, true],
      [done, true]
    ])
    // Reported after the response frame was written, never before.
    const [first] = s.reports
    expect(s.frames.slice(0, first?.framesSent).at(-1)).toMatchObject({
      result: { structuredContent: { status: 'done' } }
    })
    await s.client.close()
    await s.server.close()
  })

  it('[INV-68] a done answer whose connection closed before its response is reported not flushed', async () => {
    const done: SubtaskResultView = { status: 'done', outcome: { kind: 'concluded', text: 'ok' } }
    const s = await reporting((close) => {
      close()
      return done
    })

    await s.client
      .callTool({ name: 'subtask_result', arguments: { ticket: 'ticket-205' } })
      .catch(() => undefined)
    for (let i = 0; i < 20; i += 1) await Promise.resolve()

    expect(s.reports.map((r) => [r.answer, r.flushed])).toStrictEqual([[done, false]])
    await s.server.close()
  })

  it('[INV-68] a pending or failed answer is never reported: only a done answer is a handoff', async () => {
    const pending: SubtaskResultView = { status: 'pending', ticket: 'ticket-205' }
    const s = await reporting(() => pending)

    await s.client.callTool({ name: 'subtask_result', arguments: { ticket: 'ticket-205' } })

    expect(s.reports).toStrictEqual([])
    await s.client.close()
    await s.server.close()
  })
})
