import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOOK_ROUTE, HOOK_TOKEN_HEADER } from './hookCommand'
import type { HookEvent } from './hookPayload'
import { MAX_HOOK_BODY_BYTES, HookServer } from './hookServer'

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('HookServer', () => {
  let server: HookServer
  let received: HookEvent[]

  beforeEach(async () => {
    received = []
    // Port 0 asks the OS for a free port: the suite must never depend on the
    // real 47821 being available, nor collide with a running app.
    server = new HookServer({ port: 0, token: TOKEN, onEvent: (event) => received.push(event) })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  function url(path = HOOK_ROUTE): string {
    return `http://127.0.0.1:${server.port}${path}`
  }

  async function post(
    body: string,
    init: { token?: string | null; path?: string; method?: string } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = {}
    const token = init.token === undefined ? TOKEN : init.token
    if (token !== null) headers[HOOK_TOKEN_HEADER] = token
    return fetch(url(init.path), { method: init.method ?? 'POST', headers, body })
  }

  const stopPayload = JSON.stringify({
    session_id: 'sess-1',
    cwd: 'C:\\repo',
    hook_event_name: 'Stop',
    stop_hook_active: false
  })

  it('binds loopback and reports the port it actually got', () => {
    expect(server.port).toBeGreaterThan(0)
  })

  it('accepts a well-formed event and answers 204 with an empty body', async () => {
    const response = await post(stopPayload)
    expect(response.status).toBe(204)
    // A SessionStart hook's stdout is injected into Claude's context, so the
    // relay must be able to print nothing at all.
    expect(await response.text()).toBe('')
    expect(received).toEqual([
      { provider: 'claude', event: 'Stop', sessionId: 'sess-1', cwd: 'C:\\repo' }
    ])
  })

  it.each([
    ['a missing token', null],
    ['an empty token', ''],
    ['a wrong token', 'b1b2c3d4e5f60718293a4b5c6d7e8f90'],
    ['a truncated token', 'a1b2c3d4']
  ])('rejects %s with 401 and raises no event', async (_label, token) => {
    const response = await post(stopPayload, { token })
    expect(response.status).toBe(401)
    expect(received).toEqual([])
  })

  it('rejects any other path with 404', async () => {
    const response = await post(stopPayload, { path: '/event' })
    expect(response.status).toBe(404)
    expect(received).toEqual([])
  })

  it.each(['GET', 'PUT', 'DELETE'])('rejects %s with 404', async (method) => {
    const response = await fetch(url(), {
      method,
      headers: { [HOOK_TOKEN_HEADER]: TOKEN }
    })
    expect(response.status).toBe(404)
    expect(received).toEqual([])
  })

  it.each([
    ['malformed JSON', '{ not json'],
    ['an empty body', ''],
    ['an event we never install', JSON.stringify({ hook_event_name: 'PreToolUse' })],
    ['a JSON array', '[]']
  ])('answers 400 for %s and raises no event', async (_label, body) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(received).toEqual([])
  })

  it('refuses a body larger than the cap without buffering it', async () => {
    const oversized = JSON.stringify({
      hook_event_name: 'Stop',
      filler: 'x'.repeat(MAX_HOOK_BODY_BYTES)
    })
    // The connection is cut mid-upload, so either a 413 or a transport error
    // is a correct outcome; what matters is that no event is raised.
    await post(oversized).catch(() => undefined)
    expect(received).toEqual([])
  })

  it('accepts a body right at the cap', async () => {
    const filler = 'y'.repeat(
      MAX_HOOK_BODY_BYTES - JSON.stringify({ hook_event_name: 'Stop', filler: '' }).length
    )
    const body = JSON.stringify({ hook_event_name: 'Stop', filler })
    expect(Buffer.byteLength(body)).toBe(MAX_HOOK_BODY_BYTES)
    expect((await post(body)).status).toBe(204)
    expect(received).toHaveLength(1)
  })

  it('hands the notification type through to the listener (issue #94)', async () => {
    // The field is parsed at the boundary, so what the consumer receives is the
    // only place its survival across the POST can be seen.
    await post(
      JSON.stringify({
        session_id: 'sess-1',
        cwd: 'C:\\repo',
        hook_event_name: 'Notification',
        notification_type: 'agent_needs_input'
      })
    )
    expect(received).toEqual([
      {
        provider: 'claude',
        event: 'Notification',
        sessionId: 'sess-1',
        cwd: 'C:\\repo',
        notificationType: 'agent_needs_input'
      }
    ])
  })

  it('handles a burst of events without dropping any', async () => {
    await Promise.all(Array.from({ length: 10 }, () => post(stopPayload)))
    expect(received).toHaveLength(10)
  })

  it('is safe to start twice and stop twice', async () => {
    const port = server.port
    await server.start()
    expect(server.port).toBe(port)
    await server.stop()
    await server.stop()
  })

  it('stops answering once stopped', async () => {
    const stopped = url()
    await server.stop()
    await expect(fetch(stopped, { method: 'POST', body: stopPayload })).rejects.toThrow()
  })

  it('never lets a listener callback failure reach the caller', async () => {
    const throwing = new HookServer({
      port: 0,
      token: TOKEN,
      onEvent: () => {
        throw new Error('poller exploded')
      }
    })
    await throwing.start()
    try {
      const response = await fetch(`http://127.0.0.1:${throwing.port}${HOOK_ROUTE}`, {
        method: 'POST',
        headers: { [HOOK_TOKEN_HEADER]: TOKEN },
        body: stopPayload
      })
      expect(response.status).toBe(204)
    } finally {
      await throwing.stop()
    }
  })
})

describe('HookServer bind failures', () => {
  it('rejects when the port is already taken, leaving nothing listening', async () => {
    const first = new HookServer({ port: 0, token: TOKEN, onEvent: () => undefined })
    await first.start()
    const second = new HookServer({ port: first.port, token: TOKEN, onEvent: () => undefined })
    try {
      await expect(second.start()).rejects.toThrow()
      // A failed start must not leave a half-open server behind.
      await second.stop()
    } finally {
      await first.stop()
    }
  })

  it('refuses to start without a token rather than accepting every caller', async () => {
    const insecure = new HookServer({ port: 0, token: '', onEvent: () => undefined })
    await expect(insecure.start()).rejects.toThrow(/token/i)
  })
})
