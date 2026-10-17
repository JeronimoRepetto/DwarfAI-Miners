// L2 tests of the shared line-framed JSON-RPC client over stdio (15 §0 "JSON-RPC request timeout",
// §4.4 Transport; HO-11): three queues with server requests before notifications, a 30 000 ms
// request timeout on the Scheduler, EOF failing every pending waiter, and an unknown server
// request answered `-32601` with the drift logged (15 §1.4 `ask.opened`: fail closed).
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import {
  JSON_RPC_REQUEST_TIMEOUT_MS,
  JsonRpcStdioClient,
  METHOD_NOT_FOUND,
  type JsonRpcFailure,
  type JsonRpcNotification,
  type JsonRpcRequest
} from './JsonRpcStdioClient'

/** Lets pending continuations run; no timer is involved (the clock is fake). */
async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) {
    await new Promise<void>((resolve) => process.nextTick(resolve))
  }
}

interface Rig {
  readonly client: JsonRpcStdioClient
  /** What the server writes (the client reads it). */
  readonly server: PassThrough
  /** Every frame the client wrote, parsed. */
  readonly written: unknown[]
  readonly requests: JsonRpcRequest[]
  readonly notifications: JsonRpcNotification[]
  /** The order requests and notifications reached the client's owner. */
  readonly order: string[]
  readonly drift: string[]
  readonly ends: number[]
  readonly clock: FakeClock
}

function rig(known: readonly string[] = []): Rig {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const server = new PassThrough()
  const toServer = new PassThrough()
  const written: unknown[] = []
  let pending = ''
  toServer.setEncoding('utf8')
  toServer.on('data', (chunk: string) => {
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      written.push(JSON.parse(pending.slice(0, newline)))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  })
  const out: Omit<Rig, 'client'> = {
    server,
    written,
    requests: [],
    notifications: [],
    order: [],
    drift: [],
    ends: [],
    clock
  }
  const client = new JsonRpcStdioClient({
    input: server,
    output: toServer,
    scheduler,
    onRequest: (request) => {
      if (!known.includes(request.method)) return false
      out.requests.push(request)
      out.order.push(`request ${request.method}`)
      return true
    },
    onNotification: (notification) => {
      out.notifications.push(notification)
      out.order.push(`notification ${notification.method}`)
    },
    onDrift: (detail) => out.drift.push(detail),
    onEnd: () => out.ends.push(clock.now())
  })
  return { ...out, client }
}

function track<T>(promise: Promise<T>): { state: string; value?: unknown } {
  const tracked: { state: string; value?: unknown } = { state: 'pending' }
  promise.then(
    (value) => Object.assign(tracked, { state: 'resolved', value }),
    (error: unknown) => Object.assign(tracked, { state: 'rejected', value: error })
  )
  return tracked
}

describe('JsonRpcStdioClient', () => {
  it('[C-18, CH-04] EOF fails every pending waiter and ends the stream once', async () => {
    const { client, server, ends } = rig()
    const first = track(client.request('thread/start', { cwd: '/work/mine' }))
    const second = track(client.request('turn/start', { threadId: 't-1', input: [] }))
    await settle()
    expect([first.state, second.state]).toEqual(['pending', 'pending'])
    server.end()
    server.destroy()
    await settle()
    const closed: JsonRpcFailure = { kind: 'closed' }
    expect(first).toEqual({ state: 'rejected', value: closed })
    expect(second).toEqual({ state: 'rejected', value: closed })
    expect(ends).toEqual([0])
    // A request after the end fails at once, and the end is not reported again.
    const late = track(client.request('turn/interrupt', { threadId: 't-1', turnId: 'u-1' }))
    await settle()
    expect(late).toEqual({ state: 'rejected', value: closed })
    expect(ends).toEqual([0])
    expect(client.ended).toBe(true)
  })

  it('[C-11, FM-070] an unknown server request is answered -32601, opens no ask and logs the drift', async () => {
    const { server, written, requests, drift } = rig(['item/commandExecution/requestApproval'])
    server.write(
      `${JSON.stringify({ id: 106, method: 'account/chatgptAuthTokens/refresh', params: {} })}\n`
    )
    await settle()
    expect(requests).toEqual([])
    expect(written).toEqual([
      {
        jsonrpc: '2.0',
        id: 106,
        error: { code: METHOD_NOT_FOUND, message: 'Method not found' }
      }
    ])
    expect(METHOD_NOT_FOUND).toBe(-32601)
    expect(drift).toEqual(['unknown server request account/chatgptAuthTokens/refresh'])
  })

  it('[C-15, CH-05] a request with no reply times out at 30 000 ms on the FakeClock', async () => {
    const { client, clock } = rig()
    expect(JSON_RPC_REQUEST_TIMEOUT_MS).toBe(30_000)
    const waiting = track(client.request('turn/start', { threadId: 't-1', input: [] }))
    clock.advance(29_999)
    await settle()
    expect(waiting.state).toBe('pending')
    clock.advance(1)
    await settle()
    expect(waiting).toEqual({ state: 'rejected', value: { kind: 'timeout' } })
  })

  it('[HO-11] a response resolves its own waiter by id and an error reply rejects it with its code', async () => {
    const { client, server, written } = rig()
    const start = track(client.request('thread/start', { cwd: '/work/mine' }))
    const turn = track(client.request('turn/start', { threadId: 't-1', input: [] }))
    await settle()
    expect(written).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'thread/start', params: { cwd: '/work/mine' } },
      { jsonrpc: '2.0', id: 2, method: 'turn/start', params: { threadId: 't-1', input: [] } }
    ])
    server.write(`{"id":2,"error":{"code":-32600,"message":"no thread"}}\r\n`)
    server.write('{"id":1,"res')
    server.write('ult":{"thread":{"id":"t-1"}}}\n')
    await settle()
    expect(start).toEqual({ state: 'resolved', value: { thread: { id: 't-1' } } })
    expect(turn).toEqual({
      state: 'rejected',
      value: { kind: 'error', code: -32600, message: 'no thread' }
    })
  })

  it('[HO-11] server requests read together with notifications reach the owner first', async () => {
    const { server, order } = rig(['item/commandExecution/requestApproval'])
    server.write(
      [
        '{"method":"item/started","params":{"threadId":"t-1"}}',
        '{"id":7,"method":"item/commandExecution/requestApproval","params":{"threadId":"t-1"}}',
        '{"method":"serverRequest/resolved","params":{"threadId":"t-1","requestId":7}}',
        ''
      ].join('\n')
    )
    await settle()
    expect(order).toEqual([
      'request item/commandExecution/requestApproval',
      'notification item/started',
      'notification serverRequest/resolved'
    ])
  })

  it('[HO-33] a malformed line is drift and the stream continues', async () => {
    const { server, notifications, drift } = rig()
    server.write('not json\n{"jsonrpc":"2.0"}\n{"method":"turn/started","params":{}}\n')
    await settle()
    expect(drift).toEqual(['malformed line', 'malformed message'])
    expect(notifications.map((n) => n.method)).toEqual(['turn/started'])
  })

  it('[HO-11] an answer to a server request and a notification are written as JSON-RPC frames', async () => {
    const { client, written } = rig()
    expect(client.respond(7, { decision: 'decline' })).toBe(true)
    client.notify('initialized', {})
    await settle()
    expect(written).toEqual([
      { jsonrpc: '2.0', id: 7, result: { decision: 'decline' } },
      { jsonrpc: '2.0', method: 'initialized', params: {} }
    ])
  })
})
