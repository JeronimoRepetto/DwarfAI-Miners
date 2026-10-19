// layer: L6
// The Claude hooks route of the loopback ingress (ADR-016 items 1–4; ADR-012 item 6; 18 C-16b, T-39,
// T-40; 19 §9.2 `ingress.rejected`; 13 FM-038), over the real `node:http` listener on 127.0.0.1 and
// an OS-chosen port. The tokens are drawn at run time, so no token value is written into the
// repository.
import { createServer, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashOf } from '../../modules/preferences/testing/inMemoryChannelTokens'
import {
  applyIngressServerLimits,
  INGRESS_HEADERS_TIMEOUT_MS,
  INGRESS_MAX_CONNECTIONS,
  INGRESS_RATE_LIMIT_REQUESTS,
  INGRESS_REQUEST_TIMEOUT_MS,
  INGRESS_RATE_LIMIT_WINDOW_MS,
  MAX_INGRESS_BODY_BYTES
} from './httpIngress'
import {
  FAULT_MARKER,
  hookBody,
  post,
  startHarness,
  T0,
  type Harness
} from './testing/ingressHarness'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setUp(options?: Parameters<typeof startHarness>[0]): Promise<Harness> {
  const harness = await startHarness(options)
  cleanups.push(() => harness.ingress.close())
  return harness
}

function rejected(causeClass: string) {
  return { level: 'warn', event: 'ingress.rejected', subsystem: 'claude-hooks', causeClass }
}

/** A JSON hook body padded with an ignored field to exactly `bytes` bytes. */
function bodyOfSize(bytes: number): string {
  const base = hookBody({ padding: '' })
  return hookBody({ padding: 'x'.repeat(bytes - Buffer.byteLength(base)) })
}

describe('the Claude hooks route of the loopback ingress (ADR-016)', () => {
  it('[ADR-016] a hook event with the active Claude hooks token is accepted and nudges the observer', async () => {
    const h = await setUp()

    const answer = await post(h.port, {
      headers: { 'x-dwarfai-token': h.token, 'content-type': 'application/json' },
      body: hookBody()
    })

    expect(answer.status).toBe(204)
    expect(answer.body).toBe('')
    expect(h.observation.nudges()).toStrictEqual([
      {
        providerId: 'claude',
        sessionId: 'session-1',
        path: '/home/j/.claude/projects/-home-j-mine/session-1.jsonl'
      }
    ])
    // The permission-prompt evidence handed to the observed-Claude channel (ISSUE-134).
    expect(h.evidence).toStrictEqual([
      {
        event: 'Notification',
        sessionId: 'session-1',
        cwd: '/home/j/mine',
        transcriptPath: '/home/j/.claude/projects/-home-j-mine/session-1.jsonl',
        notificationType: 'permission_prompt'
      }
    ])
    expect(h.log.byEvent('ingress.rejected')).toStrictEqual([])
  })

  it('[ADR-016] a missing, wrong or revoked token gets 401, and a plugin token on a Claude route gets 401', async () => {
    const h = await setUp()
    const plugin = h.channelTokens.issue('opencode-plugin', T0)
    const revoked = h.token
    const active = h.channelTokens.issue('claude-hooks', T0 + 1)

    const presented: Array<Record<string, string>> = [
      {},
      { 'x-dwarfai-token': '' },
      { 'x-dwarfai-token': 'not-a-token' },
      { 'x-dwarfai-token': revoked },
      { 'x-dwarfai-token': plugin },
      // A stored hash is not the token: the store holds only hashes (ADR-016 item 1).
      { 'x-dwarfai-token': hashOf(revoked) },
      { 'x-dwarfai-token': hashOf(active) }
    ]
    for (const headers of presented) {
      const answer = await post(h.port, { headers, body: hookBody() })
      expect(answer.status, JSON.stringify(Object.keys(headers))).toBe(401)
    }

    expect(h.observation.calls).toStrictEqual([])
    expect(h.evidence).toStrictEqual([])
    // Each refusal is logged exactly once, by the token check (ISSUE-219).
    expect(h.log.byEvent('ingress.rejected')).toStrictEqual(presented.map(() => rejected('401')))
  })

  it('[ADR-012] with claude-hooks off or on-unverified every Claude hook route answers 401 and opens nothing', async () => {
    const h = await setUp()
    const paths = ['/hooks/claude/event', '/hooks/claude/SessionStart', '/hooks/claude/']

    for (const state of ['off', 'on-unverified'] as const) {
      h.setState(state)
      for (const path of paths) {
        const answer = await post(h.port, {
          path,
          headers: { 'x-dwarfai-token': h.token },
          body: hookBody()
        })
        expect(answer.status, `${state} ${path}`).toBe(401)
      }
    }

    expect(h.observation.calls).toStrictEqual([])
    expect(h.evidence).toStrictEqual([])
    expect(h.log.byEvent('ingress.rejected')).toStrictEqual(
      [...paths, ...paths].map(() => rejected('401'))
    )

    // The same token is accepted again once the integration is on-verified.
    h.setState('on-verified')
    const answer = await post(h.port, { headers: { 'x-dwarfai-token': h.token }, body: hookBody() })
    expect(answer.status).toBe(204)
  })

  it('[ADR-016] a request with an Origin header or a foreign Host header gets 403', async () => {
    const h = await setUp()
    const auth = { 'x-dwarfai-token': h.token }

    const origins = ['http://evil.example', 'null', `http://127.0.0.1:${h.port}`]
    for (const origin of origins) {
      const answer = await post(h.port, { headers: { ...auth, origin }, body: hookBody() })
      expect(answer.status, origin).toBe(403)
    }
    const hosts = [
      `localhost:${h.port}`,
      `evil.example:${h.port}`,
      `127.0.0.1:${h.port + 1}`,
      '127.0.0.1',
      `[::1]:${h.port}`
    ]
    for (const host of hosts) {
      const answer = await post(h.port, { headers: { ...auth, host }, body: hookBody() })
      expect(answer.status, host).toBe(403)
    }
    // A CORS preflight is never approved.
    const preflight = await post(h.port, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-dwarfai-token'
      }
    })
    expect(preflight.status).toBe(403)
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined()

    expect(h.observation.calls).toStrictEqual([])
    expect(h.evidence).toStrictEqual([])
    expect(h.log.byEvent('ingress.rejected')).toStrictEqual([
      ...origins.map(() => rejected('403-origin')),
      ...hosts.map(() => rejected('403-host')),
      rejected('403-origin')
    ])
  })

  it('[ADR-016] a body above 256 KiB gets 413 and a burst above the rate limit is refused', async () => {
    const h = await setUp()
    const auth = { 'x-dwarfai-token': h.token }

    // Exactly the cap is accepted.
    const atCap = await post(h.port, { headers: auth, body: bodyOfSize(MAX_INGRESS_BODY_BYTES) })
    expect(atCap.status).toBe(204)

    // A declared length above the cap is refused before any of the body is read: the request
    // is still open when the answer arrives.
    const declared = await post(h.port, {
      headers: { ...auth, 'content-length': String(MAX_INGRESS_BODY_BYTES + 1) },
      body: '{',
      keepOpen: true
    })
    expect(declared.status).toBe(413)

    // A chunked body that grows past the cap is refused as soon as it does, without waiting
    // for its end.
    const chunked = await post(h.port, {
      headers: auth,
      body: bodyOfSize(MAX_INGRESS_BODY_BYTES + 64 * 1024),
      chunked: true,
      keepOpen: true
    })
    expect(chunked.status).toBe(413)
    expect(h.evidence).toHaveLength(1)

    // The burst: the window already holds the three requests above.
    const h2 = await setUp()
    const auth2 = { 'x-dwarfai-token': h2.token }
    for (let i = 0; i < INGRESS_RATE_LIMIT_REQUESTS; i++) {
      const answer = await post(h2.port, { headers: auth2, body: hookBody() })
      expect(answer.status, `request ${i}`).toBe(204)
    }
    const over = await post(h2.port, { headers: auth2, body: hookBody() })
    expect(over.status).toBe(429)
    expect(h2.evidence).toHaveLength(INGRESS_RATE_LIMIT_REQUESTS)

    // The limit is a sliding window on the Host clock: once it passed, events are accepted again.
    h2.clock.advance(INGRESS_RATE_LIMIT_WINDOW_MS)
    const after = await post(h2.port, { headers: auth2, body: hookBody() })
    expect(after.status).toBe(204)

    expect(h.log.byEvent('ingress.rejected')).toStrictEqual([rejected('413'), rejected('413')])
    expect(h2.log.byEvent('ingress.rejected')).toStrictEqual([rejected('rate-limited')])
  })

  it('[ADR-016] a payload that fails the strict schema is refused with 400 and reaches nothing', async () => {
    const h = await setUp()
    const auth = { 'x-dwarfai-token': h.token }
    const bodies = [
      '',
      'not json',
      '[]',
      'null',
      JSON.stringify({ session_id: 'session-1' }),
      hookBody({ hook_event_name: 'NotAHookEvent' }),
      hookBody({ hook_event_name: 42 }),
      hookBody({ session_id: 42 }),
      hookBody({ cwd: ['/home/j'] }),
      hookBody({ notification_type: { nested: true } }),
      '{"__proto__":{"hook_event_name":"Stop"}}'
    ]

    for (const body of bodies) {
      const answer = await post(h.port, { headers: auth, body })
      expect(answer.status, body.slice(0, 40)).toBe(400)
    }

    expect(h.observation.calls).toStrictEqual([])
    expect(h.evidence).toStrictEqual([])
    expect(h.log.byEvent('ingress.rejected')).toStrictEqual(bodies.map(() => rejected('400')))
  })

  it('[ADR-016] an accepted event never answers an ask, launches, ends a session or changes a setting', async () => {
    // The route's only downstream reach is `ObservationControl.nudge` and the evidence hand-off;
    // the answer is sent before either runs and never waits for them.
    let release: () => void = () => undefined
    const handedOff: unknown[] = []
    const h = await setUp({
      evidence: {
        accept: (item) => {
          handedOff.push(item)
          // A hand-off that never settles while the client waits for its answer.
          return new Promise<void>((resolve) => {
            release = resolve
          }) as unknown as void
        }
      }
    })
    const auth = { 'x-dwarfai-token': h.token }

    const events = ['SessionStart', 'Stop', 'SubagentStop', 'SessionEnd', 'Notification']
    for (const event of events) {
      const answer = await post(h.port, {
        headers: auth,
        body: hookBody({ hook_event_name: event })
      })
      expect(answer.status, event).toBe(204)
    }
    release()

    expect(h.observation.calls.map((call) => call.member)).toStrictEqual(events.map(() => 'nudge'))
    expect(handedOff).toHaveLength(events.length)
    // Evidence is data only: nothing in it can be called back.
    for (const item of handedOff) {
      expect(Object.values(item as object).every((value) => typeof value === 'string')).toBe(true)
    }

    // A failing downstream never turns into an error answer the hook could act on.
    const failing = await setUp({
      observation: {
        nudge: () => {
          throw new Error('observer down')
        }
      },
      evidence: {
        accept: () => {
          throw new Error('channel down')
        }
      }
    })
    const first = await post(failing.port, {
      headers: { 'x-dwarfai-token': failing.token },
      body: hookBody()
    })
    const second = await post(failing.port, {
      headers: { 'x-dwarfai-token': failing.token },
      body: hookBody()
    })
    expect([first.status, second.status]).toStrictEqual([204, 204])
  })

  it('[NFR-SEC-12] the token and the payload never reach a log line; the status is logged with channel and code only', async () => {
    const h = await setUp()
    const plugin = h.channelTokens.issue('opencode-plugin', T0)
    const secretish = 'payload-marker-7f3a'
    const body = hookBody({ session_id: secretish, cwd: `/home/j/${secretish}` })

    await post(h.port, { headers: { 'x-dwarfai-token': h.token }, body })
    await post(h.port, { headers: { 'x-dwarfai-token': plugin }, body })
    await post(h.port, {
      headers: { 'x-dwarfai-token': h.token, origin: 'http://x.example' },
      body
    })
    await post(h.port, { headers: { 'x-dwarfai-token': h.token, host: 'x.example' }, body })
    await post(h.port, {
      headers: { 'x-dwarfai-token': h.token },
      body: hookBody({ hook_event_name: secretish })
    })
    await post(h.port, {
      headers: { 'x-dwarfai-token': h.token },
      body: `${secretish}${'x'.repeat(MAX_INGRESS_BODY_BYTES)}`
    })
    h.setState('off')
    await post(h.port, { headers: { 'x-dwarfai-token': h.token }, body })

    expect(h.log.refused).toStrictEqual([])
    expect(h.log.byEvent('ingress.rejected')).toHaveLength(6)
    for (const entry of h.log.byEvent('ingress.rejected')) {
      expect(Object.keys(entry).sort()).toStrictEqual(['causeClass', 'event', 'level', 'subsystem'])
      expect(entry.subsystem).toBe('claude-hooks')
    }
    const logged = JSON.stringify(h.log.entries).toLowerCase()
    for (const secret of [h.token, plugin, hashOf(h.token), secretish, 'permission']) {
      expect(logged).not.toContain(secret.toLowerCase())
    }
  })

  it('[ADR-016, ADR-002] a dependency that throws during admission gets a bodyless 500, escapes nothing, and the ingress keeps serving', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => void uncaught.push(error)
    process.on('uncaughtException', onUncaught)
    try {
      for (const fault of ['integrationState', 'tokensActive'] as const) {
        const h = await setUp({ fault })
        const auth = { 'x-dwarfai-token': h.token }

        const first = await post(h.port, { headers: auth, body: hookBody(), answerWithinMs: 1_500 })
        const second = await post(h.port, {
          headers: auth,
          body: hookBody(),
          answerWithinMs: 1_500
        })
        for (const answer of [first, second]) {
          expect(answer, fault).not.toBe('no-answer')
          if (answer === 'no-answer') continue
          expect(answer.status, fault).toBe(500)
          expect(answer.body, fault).toBe('')
        }
        // A request refused before admission is still answered as before.
        const origin = await post(h.port, { headers: { ...auth, origin: 'http://x.example' } })
        expect(origin.status, fault).toBe(403)

        expect(h.observation.calls, fault).toStrictEqual([])
        expect(h.evidence, fault).toStrictEqual([])
        expect(h.log.byEvent('ingress.rejected'), fault).toStrictEqual([
          rejected('500'),
          rejected('500'),
          rejected('403-origin')
        ])
        const logged = JSON.stringify([h.log.entries, h.log.refused]).toLowerCase()
        for (const secret of [h.token, FAULT_MARKER, 'db locked']) {
          expect(logged, fault).not.toContain(secret.toLowerCase())
        }
      }
      expect(uncaught).toStrictEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })

  it('[ADR-016] the hook has its answer before the observer is nudged or the evidence handed on', async () => {
    const end = vi.spyOn(ServerResponse.prototype, 'end')
    try {
      const seen: Array<{ at: 'nudge' | 'evidence'; answered: boolean }> = []
      let endsBefore = 0
      const answered = (): boolean => {
        const responses = end.mock.contexts as ServerResponse[]
        const last = responses.at(-1)
        return responses.length > endsBefore && last !== undefined && last.writableFinished
      }
      const h = await setUp({
        observation: { nudge: () => void seen.push({ at: 'nudge', answered: answered() }) },
        evidence: { accept: () => void seen.push({ at: 'evidence', answered: answered() }) }
      })

      for (let i = 0; i < 3; i++) {
        endsBefore = end.mock.contexts.length
        const answer = await post(h.port, {
          headers: { 'x-dwarfai-token': h.token },
          body: hookBody()
        })
        expect(answer.status).toBe(204)
      }

      expect(seen).toStrictEqual(
        [0, 1, 2].flatMap(() => [
          { at: 'nudge', answered: true },
          { at: 'evidence', answered: true }
        ])
      )
    } finally {
      end.mockRestore()
    }
  })

  it('[ADR-016] the listener bounds a stalled request and the number of open connections', () => {
    const server = applyIngressServerLimits(createServer())

    expect(INGRESS_REQUEST_TIMEOUT_MS).toBe(10_000)
    expect(INGRESS_HEADERS_TIMEOUT_MS).toBe(5_000)
    expect(INGRESS_MAX_CONNECTIONS).toBe(64)
    expect({
      requestTimeout: server.requestTimeout,
      headersTimeout: server.headersTimeout,
      maxConnections: server.maxConnections,
      keepAliveTimeout: server.keepAliveTimeout
    }).toStrictEqual({
      requestTimeout: INGRESS_REQUEST_TIMEOUT_MS,
      headersTimeout: INGRESS_HEADERS_TIMEOUT_MS,
      maxConnections: INGRESS_MAX_CONNECTIONS,
      keepAliveTimeout: 1_000
    })
  })

  it('[ADR-016] the evidence carries ids and paths exactly as Claude sent them', async () => {
    const h = await setUp()
    const auth = { 'x-dwarfai-token': h.token }

    const answer = await post(h.port, {
      headers: auth,
      body: hookBody({
        session_id: ' session-1',
        cwd: '/home/j/mine ',
        transcript_path: '/home/j/.claude/projects/-home-j-mine/session-1.jsonl '
      })
    })
    expect(answer.status).toBe(204)
    expect(h.evidence).toStrictEqual([
      {
        event: 'Notification',
        sessionId: ' session-1',
        cwd: '/home/j/mine ',
        transcriptPath: '/home/j/.claude/projects/-home-j-mine/session-1.jsonl ',
        notificationType: 'permission_prompt'
      }
    ])

    // Blank text is still refused.
    const blank = await post(h.port, { headers: auth, body: hookBody({ cwd: '   ' }) })
    expect(blank.status).toBe(400)
  })
})
