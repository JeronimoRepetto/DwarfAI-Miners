// The JevRouter conformance suite (16 §6.6 "No key → no network call", §6.3 "never throws", §6.5
// "8 000 ms per attempt, aborted by `signal`"; 17 §1.3): run on `FakeJevRouter` and on
// `TypesafeJevRouter` over a scripted fetch. Each case asks both requests (`route` and `routeModel`),
// since the port's two methods carry the same failure rules. Never imported by production code (R14).
import { describe, expect, it } from 'vitest'
import type { FakeClock } from '../../../kernel/fakes/FakeClock'
import {
  JEV_ATTEMPT_TIMEOUT_MS,
  type JevModelRequest,
  type JevModelResponse,
  type JevRouteRequest,
  type JevRouteResponse,
  type JevRouter
} from '../ports/jevRouter'

/**
 * What TypeSafe does with the next request the subject sends. `answers` is a well-formed answer to
 * whichever request was sent; `hang` never answers until the request is aborted.
 */
export type JevRouterScript =
  | { kind: 'answers' }
  | { kind: 'status'; status: 401 | 403 | 429 | 500 }
  | { kind: 'network-error' }
  | { kind: 'invalid-body' }
  | { kind: 'hang' }

export interface JevRouterSubject {
  router: JevRouter
  /** The clock the subject's Scheduler runs on: advancing it fires the attempt timeout. */
  clock: FakeClock
  /** How many requests left the process (the real adapter: fetch calls). */
  requestsSent(): number
}

/** A key the contract passes when it wants a request to be sent. Synthetic, never a real key. */
export const CONTRACT_JEV_KEY = 'ts-contract-key-0000'

/** A first request as the domain builds it (16 §6.2): only criteria text, never an id or path. */
export const CONTRACT_ROUTE_REQUEST: JevRouteRequest = {
  prompt: 'Rename the helper in one file',
  routingProfile: 'balanced',
  truncated: false,
  providerCriteria: {
    claude: { what: 'A coding agent.', examples: ['Fix a bug.', 'Write a test.'] },
    no_preference: { what: 'Any provider.', examples: ['Anything.', 'Whatever fits.'] }
  }
}

/** A second request over two candidates keyed by index (16 §6.2: never a model id). */
export const CONTRACT_MODEL_REQUEST: JevModelRequest = {
  prompt: 'Rename the helper in one file',
  routingProfile: 'balanced',
  truncated: false,
  tier: 'balanced',
  candidates: {
    '0': {
      what: 'A balanced model.',
      examples: ['Edit a file.', 'Explain code.'],
      tier: 'balanced',
      relativeCost: 'low'
    },
    '1': {
      what: 'Another balanced model.',
      examples: ['Edit two files.', 'Review a diff.'],
      tier: 'balanced',
      relativeCost: 'medium'
    }
  }
}

type Ask = (
  subject: JevRouterSubject,
  key: string,
  signal?: AbortSignal
) => Promise<JevRouteResponse | JevModelResponse>

const REQUESTS: ReadonlyArray<{ name: string; ask: Ask }> = [
  {
    name: 'route',
    ask: (subject, key, signal) =>
      subject.router.route(CONTRACT_ROUTE_REQUEST, key, signal === undefined ? {} : { signal })
  },
  {
    name: 'routeModel',
    ask: (subject, key, signal) =>
      subject.router.routeModel(CONTRACT_MODEL_REQUEST, key, signal === undefined ? {} : { signal })
  }
]

/** Lets every pending promise chain run (no timer involved). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Calls `ask` and turns a throw into a failed expectation naming the request. */
async function never(
  name: string,
  call: Promise<JevRouteResponse | JevModelResponse>
): Promise<JevRouteResponse | JevModelResponse> {
  try {
    return await call
  } catch (error) {
    throw new Error(`${name} threw instead of resolving a fallback: ${String(error)}`)
  }
}

export function runJevRouterContract(
  makeSubject: (script: JevRouterScript) => JevRouterSubject | Promise<JevRouterSubject>
): void {
  describe('JevRouter contract', () => {
    it('[ADR-017, INV-88, FM-121] with no key no request leaves the process and the fallback is no-key', async () => {
      for (const { name, ask } of REQUESTS) {
        for (const key of ['', '   ']) {
          const subject = await makeSubject({ kind: 'answers' })
          const result = await never(name, ask(subject, key))
          expect(result, `${name} with key ${JSON.stringify(key)}`).toStrictEqual({
            kind: 'fallback',
            reason: 'no-key'
          })
          expect(subject.requestsSent(), name).toBe(0)
        }
        // The same subject with a key does send, and answers: the rule above is about the key.
        const keyed = await makeSubject({ kind: 'answers' })
        const answered = await never(name, ask(keyed, CONTRACT_JEV_KEY))
        expect(answered.kind, name).toBe('answers')
        expect(keyed.requestsSent(), name).toBe(1)
      }
    })

    it('[FM-119] an attempt that exceeds 8 000 ms resolves as fallback timeout and never throws', async () => {
      for (const { name, ask } of REQUESTS) {
        const subject = await makeSubject({ kind: 'hang' })
        let result: JevRouteResponse | JevModelResponse | undefined
        const pending = never(name, ask(subject, CONTRACT_JEV_KEY)).then((r) => {
          result = r
          return r
        })
        await settle()
        subject.clock.advance(JEV_ATTEMPT_TIMEOUT_MS - 1)
        await settle()
        expect(result, `${name} before ${JEV_ATTEMPT_TIMEOUT_MS} ms`).toBeUndefined()
        subject.clock.advance(1)
        expect(await pending, name).toStrictEqual({ kind: 'fallback', reason: 'timeout' })
      }
    })

    it('[US-RES-006.AC02, FM-120] a key TypeSafe rejects resolves as fallback unauthorized', async () => {
      for (const { name, ask } of REQUESTS) {
        for (const status of [401, 403] as const) {
          const subject = await makeSubject({ kind: 'status', status })
          const result = await never(name, ask(subject, CONTRACT_JEV_KEY))
          expect(result, `${name} on HTTP ${status}`).toStrictEqual({
            kind: 'fallback',
            reason: 'unauthorized'
          })
        }
      }
    })

    it('[FM-119] rate-limited, unreachable and invalid-response bodies each resolve as their own fallback reason', async () => {
      const cases: ReadonlyArray<{ script: JevRouterScript; reason: string }> = [
        { script: { kind: 'status', status: 429 }, reason: 'rate-limited' },
        { script: { kind: 'status', status: 500 }, reason: 'unreachable' },
        { script: { kind: 'network-error' }, reason: 'unreachable' },
        { script: { kind: 'invalid-body' }, reason: 'invalid-response' }
      ]
      for (const { name, ask } of REQUESTS) {
        for (const { script, reason } of cases) {
          const subject = await makeSubject(script)
          const result = await never(name, ask(subject, CONTRACT_JEV_KEY))
          expect(result, `${name} on ${JSON.stringify(script)}`).toStrictEqual({
            kind: 'fallback',
            reason
          })
        }
      }
    })

    it('[INV-87] an aborted request resolves as a fallback and leaves no answer', async () => {
      for (const { name, ask } of REQUESTS) {
        // Aborted while in flight (Dismiss, a changed prompt).
        const inFlight = await makeSubject({ kind: 'hang' })
        const controller = new AbortController()
        const pending = never(name, ask(inFlight, CONTRACT_JEV_KEY, controller.signal))
        await settle()
        controller.abort()
        const aborted = await pending
        expect(aborted.kind, `${name} aborted in flight`).toBe('fallback')

        // Aborted before it was asked: nothing is sent, and the answer TypeSafe would give is unused.
        const early = await makeSubject({ kind: 'answers' })
        const before = new AbortController()
        before.abort()
        const skipped = await never(name, ask(early, CONTRACT_JEV_KEY, before.signal))
        expect(skipped.kind, `${name} aborted before`).toBe('fallback')
        expect(early.requestsSent(), `${name} aborted before`).toBe(0)
      }
    })
  })
}
