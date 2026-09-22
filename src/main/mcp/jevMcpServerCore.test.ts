import { Client } from '@modelcontextprotocol/sdk/client'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { DelegationLink } from './delegationLink'
import {
  DELEGATE_SUBTASK_TOOL_NAME,
  NATIVE_SUBAGENT_FALLBACK_SENTENCE,
  SUBTASK_RESULT_TOOL_NAME,
  type DelegationToolResult
} from './delegationProtocol'
import { createJevMcpServer } from './jevMcpServerCore'

async function connectedClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

function textOf(content: unknown): string {
  const first = Array.isArray(content) ? content[0] : undefined
  if (first === undefined || first.type !== 'text') throw new Error('expected a text content block')
  return first.text as string
}

/** A link whose two methods never resolve in a test that never calls them. */
function unreachableLink(): DelegationLink {
  return {
    delegate: async () => {
      throw new Error('delegate() should not have been called')
    },
    result: async () => {
      throw new Error('result() should not have been called')
    }
  }
}

describe('createJevMcpServer — tool listing', () => {
  it('lists exactly delegate_subtask and subtask_result, each description carrying the fallback sentence', async () => {
    const server = createJevMcpServer({ link: undefined, waitMs: 1_000 })
    const client = await connectedClient(server)

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [DELEGATE_SUBTASK_TOOL_NAME, SUBTASK_RESULT_TOOL_NAME].sort()
    )
    for (const tool of tools) {
      expect(tool.description ?? '').toContain(NATIVE_SUBAGENT_FALLBACK_SENTENCE)
    }
  })
})

describe('createJevMcpServer — delegate_subtask, configured link', () => {
  it('returns a done outcome as structured content and as JSON text', async () => {
    const outcome = { kind: 'concluded' as const, text: 'the answer', endedAt: 5 }
    const link: DelegationLink = {
      delegate: async (task, context, options) => {
        expect(task).toBe('do the thing')
        expect(context).toBe('some context')
        expect(options.waitMs).toBe(4_321)
        return { status: 'done', outcome }
      },
      result: async () => {
        throw new Error('result() should not have been called')
      }
    }
    const server = createJevMcpServer({ link, waitMs: 4_321 })
    const client = await connectedClient(server)

    const response = await client.callTool({
      name: DELEGATE_SUBTASK_TOOL_NAME,
      arguments: { task: 'do the thing', context: 'some context' }
    })

    const expected: DelegationToolResult = { status: 'done', outcome }
    expect(response.structuredContent).toEqual(expected)
    expect(JSON.parse(textOf(response.content))).toEqual(expected)
    expect(response.isError).toBeFalsy()
  })

  it('returns a pending ticket and routing untouched', async () => {
    const routing = { provider: 'claude' as const, model: 'sonnet' }
    const link: DelegationLink = {
      delegate: async () => ({ status: 'pending', ticket: 'tick-1', routing }),
      result: async () => {
        throw new Error('result() should not have been called')
      }
    }
    const server = createJevMcpServer({ link, waitMs: 1_000 })
    const client = await connectedClient(server)

    const response = await client.callTool({
      name: DELEGATE_SUBTASK_TOOL_NAME,
      arguments: { task: 'do the thing' }
    })

    const expected: DelegationToolResult = { status: 'pending', ticket: 'tick-1', routing }
    expect(response.structuredContent).toEqual(expected)
    expect(JSON.parse(textOf(response.content))).toEqual(expected)
  })

  it('returns a failed result verbatim from the link', async () => {
    const failure = {
      kind: 'jev-unreachable' as const,
      detail: `TypeSafe did not answer. ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}`
    }
    const link: DelegationLink = {
      delegate: async () => ({ status: 'failed', failure }),
      result: async () => {
        throw new Error('result() should not have been called')
      }
    }
    const server = createJevMcpServer({ link, waitMs: 1_000 })
    const client = await connectedClient(server)

    const response = await client.callTool({
      name: DELEGATE_SUBTASK_TOOL_NAME,
      arguments: { task: 'do the thing' }
    })

    expect(response.structuredContent).toEqual({ status: 'failed', failure })
  })

  it('refuses an empty task before the handler ever runs (schema-level)', async () => {
    // The link is never called: the SDK's own zod validation rejects `task`
    // before `executeToolHandler` reaches our callback, and surfaces it as
    // an ordinary tool error result (`isError: true`) rather than a
    // rejected call — observed via the installed SDK (1.30.0), not assumed.
    const server = createJevMcpServer({ link: unreachableLink(), waitMs: 1_000 })
    const client = await connectedClient(server)

    const response = await client.callTool({
      name: DELEGATE_SUBTASK_TOOL_NAME,
      arguments: { task: '' }
    })
    expect(response.isError).toBe(true)
  })
})

describe('createJevMcpServer — subtask_result, configured link', () => {
  it('looks the ticket up through the link and returns its result', async () => {
    const outcome = { kind: 'errored' as const, detail: 'error_max_turns', endedAt: 9 }
    const link: DelegationLink = {
      delegate: async () => {
        throw new Error('delegate() should not have been called')
      },
      result: async (ticket) => {
        expect(ticket).toBe('tick-42')
        return { status: 'done', outcome }
      }
    }
    const server = createJevMcpServer({ link, waitMs: 1_000 })
    const client = await connectedClient(server)

    const response = await client.callTool({
      name: SUBTASK_RESULT_TOOL_NAME,
      arguments: { ticket: 'tick-42' }
    })

    expect(response.structuredContent).toEqual({ status: 'done', outcome })
  })
})

describe('createJevMcpServer — unconfigured link', () => {
  it('answers delegate_subtask with link-unconfigured, never touching a link', async () => {
    const server = createJevMcpServer({ link: undefined, waitMs: 1_000 })
    const client = await connectedClient(server)

    const response = await client.callTool({
      name: DELEGATE_SUBTASK_TOOL_NAME,
      arguments: { task: 'do the thing' }
    })

    const content = response.structuredContent as DelegationToolResult
    expect(content.status).toBe('failed')
    if (content.status === 'failed') {
      expect(content.failure.kind).toBe('link-unconfigured')
      expect(content.failure.detail).toContain(NATIVE_SUBAGENT_FALLBACK_SENTENCE)
    }
  })

  it('answers subtask_result with link-unconfigured too', async () => {
    const server = createJevMcpServer({ link: undefined, waitMs: 1_000 })
    const client = await connectedClient(server)

    const response = await client.callTool({
      name: SUBTASK_RESULT_TOOL_NAME,
      arguments: { ticket: 'tick-1' }
    })

    const content = response.structuredContent as DelegationToolResult
    expect(content.status).toBe('failed')
    if (content.status === 'failed') expect(content.failure.kind).toBe('link-unconfigured')
  })
})
