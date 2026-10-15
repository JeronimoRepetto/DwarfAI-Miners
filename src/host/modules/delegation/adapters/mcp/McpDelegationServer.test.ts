// L3 (17 §1.3): runDelegationMcpContract over the real McpDelegationServer (16 §4.8, §5.4, §5.7):
// an MCP SDK client calls the two tools through an in-process relay connection that carries one
// JSON-RPC message per frame, as the MCP endpoint hands it over (ADR-013 item 3).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
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

async function connectedClient(handler: DelegationEndpoint, token: DelegationToken) {
  const pair = relayPair(token)
  let close: () => Promise<void> = () => Promise.resolve()
  const server = new McpDelegationServer({
    listen: (accept) => {
      accept(pair.connection)
      close = () => Promise.resolve()
      return Promise.resolve({ endpoint: { path: 'in-process' }, close: () => close() })
    }
  })
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

runDelegationMcpContract('McpDelegationServer', async (handler, token) => {
  const { client, server } = await connectedClient(handler, token)
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
    expect(delegate?.inputSchema.properties).toMatchObject({
      task: { type: 'string', minLength: 1, maxLength: 4_000 },
      context: { type: 'string', maxLength: 16_000 }
    })
    expect(delegate?.inputSchema.required).toEqual(['task'])
    expect(result?.inputSchema.properties).toMatchObject({
      ticket: { type: 'string', minLength: 1 }
    })
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
