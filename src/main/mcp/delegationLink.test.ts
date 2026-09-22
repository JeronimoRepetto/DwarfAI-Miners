import { describe, expect, it } from 'vitest'
import {
  DELEGATION_POLL_INTERVAL_MS,
  type DelegationFetch,
  createDelegationLink
} from './delegationLink'
import {
  DELEGATE_ROUTE,
  DELEGATION_TOKEN_HEADER,
  NATIVE_SUBAGENT_FALLBACK_SENTENCE
} from './delegationProtocol'

const ENDPOINT = 'http://127.0.0.1:4123'
const TOKEN = 'super-secret-token'

interface FakeCall {
  url: string
  init: { method: string; headers: Record<string, string>; body?: string }
}

/** Queue of canned responses; the last one repeats once the queue is drained. */
function fakeFetch(
  responses: ReadonlyArray<{ status: number; body: unknown } | { throws: unknown }>
): { fetch: DelegationFetch; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  let index = 0
  const fetch: DelegationFetch = async (url, init) => {
    calls.push({ url, init })
    const step = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (step === undefined) throw new Error('fakeFetch: no responses configured')
    if ('throws' in step) throw step.throws
    return { status: step.status, json: async () => step.body }
  }
  return { fetch, calls }
}

/** A shared mutable clock: sleep(ms) advances it, now() reads it — no real timers. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let clock = 0
  const slept: number[] = []
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms)
      clock += ms
    },
    slept
  }
}

function link(fetchImpl: DelegationFetch, clock: ReturnType<typeof fakeClock>) {
  return createDelegationLink({
    endpoint: ENDPOINT,
    token: TOKEN,
    fetch: fetchImpl,
    now: clock.now,
    sleep: clock.sleep
  })
}

describe('createDelegationLink.delegate — request shape', () => {
  it('POSTs the exact body, token header and content type', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 202, body: { ticket: 't-1', routing: { provider: 'claude' } } },
      {
        status: 200,
        body: { status: 'done', outcome: { kind: 'concluded', text: 'ok', endedAt: 1 } }
      }
    ])
    const clock = fakeClock()
    await link(fetch, clock).delegate('do the thing', 'some context', { waitMs: 5_000 })

    expect(calls[0]?.url).toBe(`${ENDPOINT}${DELEGATE_ROUTE}`)
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.headers[DELEGATION_TOKEN_HEADER]).toBe(TOKEN)
    expect(calls[0]?.init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({
      task: 'do the thing',
      context: 'some context'
    })
  })

  it('omits context from the body when none was given', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 202, body: { ticket: 't-1', routing: { provider: 'claude' } } },
      {
        status: 200,
        body: { status: 'done', outcome: { kind: 'concluded', text: 'ok', endedAt: 1 } }
      }
    ])
    await link(fetch, fakeClock()).delegate('do the thing', undefined, { waitMs: 5_000 })
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({ task: 'do the thing' })
  })
})

describe('createDelegationLink.delegate — polling', () => {
  it('resolves done after a handful of pending polls (n polls then done)', async () => {
    const routing = { provider: 'claude' as const }
    const { fetch, calls } = fakeFetch([
      { status: 202, body: { ticket: 't-1', routing } },
      { status: 200, body: { status: 'pending', routing } },
      { status: 200, body: { status: 'pending', routing } },
      {
        status: 200,
        body: { status: 'done', outcome: { kind: 'concluded', text: 'yes', endedAt: 3 } }
      }
    ])
    const clock = fakeClock()
    const outcome = await link(fetch, clock).delegate('t', undefined, { waitMs: 50_000 })

    expect(outcome).toEqual({
      status: 'done',
      outcome: { kind: 'concluded', text: 'yes', endedAt: 3 }
    })
    // 1 POST + 3 GET polls (two pending, one done).
    expect(calls).toHaveLength(4)
    expect(clock.slept).toEqual([
      DELEGATION_POLL_INTERVAL_MS,
      DELEGATION_POLL_INTERVAL_MS,
      DELEGATION_POLL_INTERVAL_MS
    ])
  })

  it('resolves failed as soon as a poll reports it, without waiting out the deadline', async () => {
    const routing = { provider: 'opencode' as const }
    const { fetch } = fakeFetch([
      { status: 202, body: { ticket: 't-1', routing } },
      {
        status: 200,
        body: { status: 'failed', failure: { kind: 'provider-not-launchable', detail: 'gone' } }
      }
    ])
    const outcome = await link(fetch, fakeClock()).delegate('t', undefined, { waitMs: 50_000 })
    expect(outcome).toEqual({
      status: 'failed',
      failure: { kind: 'provider-not-launchable', detail: 'gone' }
    })
  })

  it('returns pending with the ticket and routing once the deadline elapses', async () => {
    const routing = { provider: 'claude' as const, model: 'sonnet' }
    const { fetch, calls } = fakeFetch([
      { status: 202, body: { ticket: 't-9', routing } },
      { status: 200, body: { status: 'pending', routing } }
    ])
    const clock = fakeClock()
    const outcome = await link(fetch, clock).delegate('t', undefined, { waitMs: 3_000 })

    expect(outcome).toEqual({ status: 'pending', ticket: 't-9', routing })
    // 1 POST + exactly 3 polls (waitMs / interval), never a 4th past the deadline.
    expect(calls).toHaveLength(4)
    expect(clock.slept).toHaveLength(3)
  })
})

describe('createDelegationLink.delegate — refusals and transport failures', () => {
  it('maps a 409 refusal body straight through as a failed result', async () => {
    const failure = { kind: 'concurrency-limit', detail: 'too many; fall back' }
    const { fetch } = fakeFetch([{ status: 409, body: { failure } }])
    const outcome = await link(fetch, fakeClock()).delegate('t', undefined, { waitMs: 1_000 })
    expect(outcome).toEqual({ status: 'failed', failure })
  })

  it('maps a thrown fetch to link-unreachable', async () => {
    const { fetch } = fakeFetch([{ throws: new Error('ECONNREFUSED') }])
    const outcome = await link(fetch, fakeClock()).delegate('t', undefined, { waitMs: 1_000 })
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.failure.kind).toBe('link-unreachable')
      expect(outcome.failure.detail).toContain(NATIVE_SUBAGENT_FALLBACK_SENTENCE)
    }
  })

  it('maps a 401 to link-unreachable without ever echoing the token', async () => {
    const { fetch } = fakeFetch([{ status: 401, body: {} }])
    const outcome = await link(fetch, fakeClock()).delegate('t', undefined, { waitMs: 1_000 })
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.failure.kind).toBe('link-unreachable')
      expect(outcome.failure.detail).not.toContain(TOKEN)
    }
  })

  it('maps a 403 the same way as a 401', async () => {
    const { fetch } = fakeFetch([{ status: 403, body: {} }])
    const outcome = await link(fetch, fakeClock()).delegate('t', undefined, { waitMs: 1_000 })
    expect(outcome).toMatchObject({ status: 'failed', failure: { kind: 'link-unreachable' } })
  })

  it('maps a non-JSON 202 body to invalid-response', async () => {
    const { fetch } = fakeFetch([
      { status: 202, body: undefined } // json() throws below via a custom fetch
    ])
    const throwingFetch: DelegationFetch = async () => ({
      status: 202,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      }
    })
    const outcome = await link(throwingFetch, fakeClock()).delegate('t', undefined, {
      waitMs: 1_000
    })
    void fetch
    expect(outcome).toMatchObject({ status: 'failed', failure: { kind: 'invalid-response' } })
  })

  it('maps an accepted body with a bad shape to invalid-response', async () => {
    const { fetch } = fakeFetch([{ status: 202, body: { ticket: 't-1' /* no routing */ } }])
    const outcome = await link(fetch, fakeClock()).delegate('t', undefined, { waitMs: 1_000 })
    expect(outcome).toMatchObject({ status: 'failed', failure: { kind: 'invalid-response' } })
  })

  it('maps a refusal body with a bad shape to invalid-response', async () => {
    const { fetch } = fakeFetch([{ status: 409, body: { nope: true } }])
    const outcome = await link(fetch, fakeClock()).delegate('t', undefined, { waitMs: 1_000 })
    expect(outcome).toMatchObject({ status: 'failed', failure: { kind: 'invalid-response' } })
  })
})

describe('createDelegationLink.result', () => {
  it('GETs /result/<ticket> with the token header', async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        body: { status: 'done', outcome: { kind: 'concluded', text: 'x', endedAt: 1 } }
      }
    ])
    await link(fetch, fakeClock()).result('tick-7')
    expect(calls[0]?.url).toBe(`${ENDPOINT}/result/tick-7`)
    expect(calls[0]?.init.method).toBe('GET')
    expect(calls[0]?.init.headers[DELEGATION_TOKEN_HEADER]).toBe(TOKEN)
  })

  it('returns a done outcome', async () => {
    const outcome = { kind: 'concluded' as const, text: 'x', endedAt: 1 }
    const { fetch } = fakeFetch([{ status: 200, body: { status: 'done', outcome } }])
    expect(await link(fetch, fakeClock()).result('t')).toEqual({ status: 'done', outcome })
  })

  it('returns pending with ticket and routing', async () => {
    const routing = { provider: 'claude' as const }
    const { fetch } = fakeFetch([{ status: 200, body: { status: 'pending', routing } }])
    expect(await link(fetch, fakeClock()).result('t-2')).toEqual({
      status: 'pending',
      ticket: 't-2',
      routing
    })
  })

  it('returns a failed outcome verbatim, fallback sentence included by construction', async () => {
    const failure = {
      kind: 'unknown-ticket' as const,
      detail: `No such ticket. ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}`
    }
    const { fetch } = fakeFetch([{ status: 200, body: { status: 'failed', failure } }])
    expect(await link(fetch, fakeClock()).result('t-3')).toEqual({ status: 'failed', failure })
  })

  it('maps a thrown fetch to link-unreachable', async () => {
    const { fetch } = fakeFetch([{ throws: new Error('network down') }])
    const outcome = await link(fetch, fakeClock()).result('t')
    expect(outcome).toMatchObject({ status: 'failed', failure: { kind: 'link-unreachable' } })
  })

  it('maps a non-JSON body to invalid-response', async () => {
    const throwingFetch: DelegationFetch = async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError('bad json')
      }
    })
    const outcome = await link(throwingFetch, fakeClock()).result('t')
    expect(outcome).toMatchObject({ status: 'failed', failure: { kind: 'invalid-response' } })
  })
})
