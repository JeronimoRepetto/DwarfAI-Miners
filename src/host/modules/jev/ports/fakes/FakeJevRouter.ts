// The scripted `JevRouter` double (16 §4.9 "FakeJevRouter (transplanted)"; 16 §2.8), from the
// found tree's `src/main/jev/fakeJevRouter.ts`: no network, no SDK. A test queues exactly the
// answers, fallbacks and hangs it wants, and reads back every request and key the code under test
// sent. It keeps the port's own rules (16 §6.6): no key or an aborted call sends nothing, and a hang
// resolves as the fallback `timeout` after the given attempt timeout on the injected Scheduler.
// Test-only: production code never imports it (R14).
import type { Scheduler } from '../../../../kernel/ports/scheduler'
import type { SecretValue } from '../../../../kernel/ports/secretReader'
import type {
  JevModelRequest,
  JevModelResponse,
  JevRouteRequest,
  JevRouteResponse,
  JevRouter
} from '../jevRouter'

/** One call the fake received: the request and the key it was sent with. */
export interface JevRouterCall<R> {
  request: R
  key: SecretValue
}

/** A queued `route`/`routeModel` call: an answer or fallback, or a call that never answers. */
type Queued<R> = R | 'hang'

const TIMEOUT = { kind: 'fallback', reason: 'timeout' } as const
const NO_KEY = { kind: 'fallback', reason: 'no-key' } as const

export interface FakeJevRouterOptions {
  /** Where a queued hang waits for its attempt timeout. */
  scheduler?: Scheduler
  /**
   * How long a queued hang waits before it resolves as `timeout`: a test passes
   * `JEV_ATTEMPT_TIMEOUT_MS` (a ports file imports types only, R2, so the double cannot import it).
   */
  attemptTimeoutMs?: number
}

export class FakeJevRouter implements JevRouter {
  private readonly responses: Queued<JevRouteResponse>[] = []
  private readonly modelResponses: Queued<JevModelResponse>[] = []
  private readonly calls: JevRouterCall<JevRouteRequest>[] = []
  private readonly modelCalls: JevRouterCall<JevModelRequest>[] = []

  constructor(private readonly options: FakeJevRouterOptions = {}) {}

  /** Queues the next response `route` returns, in call order. */
  queueResponse(response: JevRouteResponse): void {
    this.responses.push(response)
  }

  /** Queues the next response `routeModel` returns, in call order. */
  queueModelResponse(response: JevModelResponse): void {
    this.modelResponses.push(response)
  }

  /** Queues a `route` call that never answers: it times out on the scheduler or is aborted. */
  queueHang(): void {
    this.responses.push('hang')
  }

  /** Queues a `routeModel` call that never answers: it times out on the scheduler or is aborted. */
  queueModelHang(): void {
    this.modelResponses.push('hang')
  }

  /** Every request `route` was called with, in call order. */
  requestsSeen(): readonly JevRouteRequest[] {
    return this.calls.map((call) => call.request)
  }

  /** Every request `routeModel` was called with, in call order. */
  modelRequestsSeen(): readonly JevModelRequest[] {
    return this.modelCalls.map((call) => call.request)
  }

  /** Every key either request was sent with, in call order (first requests, then second). */
  keysSeen(): readonly SecretValue[] {
    return [...this.calls, ...this.modelCalls].map((call) => call.key)
  }

  async route(
    req: JevRouteRequest,
    key: SecretValue,
    opts?: { signal?: AbortSignal }
  ): Promise<JevRouteResponse> {
    // The port's own rules (16 §6.6): no key or an aborted call sends nothing.
    if (key.trim() === '') return NO_KEY
    if (opts?.signal?.aborted === true) return TIMEOUT
    this.calls.push({ request: req, key })
    return this.play(this.responses.shift(), 'route', opts?.signal)
  }

  async routeModel(
    req: JevModelRequest,
    key: SecretValue,
    opts?: { signal?: AbortSignal }
  ): Promise<JevModelResponse> {
    if (key.trim() === '') return NO_KEY
    if (opts?.signal?.aborted === true) return TIMEOUT
    this.modelCalls.push({ request: req, key })
    return this.play(this.modelResponses.shift(), 'routeModel', opts?.signal)
  }

  private play<R>(next: Queued<R> | undefined, method: string, signal?: AbortSignal): Promise<R> {
    // Loud rather than a silent default: a test that queued nothing has a gap in its own setup,
    // not a real fallback to report (the port itself never throws, 16 §6.3).
    if (next === undefined) {
      return Promise.reject(new Error(`FakeJevRouter: ${method}() called with no response queued`))
    }
    if (next !== 'hang') return Promise.resolve(next)
    const { scheduler, attemptTimeoutMs } = this.options
    if (scheduler === undefined || attemptTimeoutMs === undefined) {
      return Promise.reject(
        new Error('FakeJevRouter: a queued hang needs a scheduler and an attempt timeout')
      )
    }
    return new Promise((resolve) => {
      const timer = scheduler.after(attemptTimeoutMs, () => {
        signal?.removeEventListener('abort', onAbort)
        resolve(TIMEOUT as R)
      })
      const onAbort = (): void => {
        timer.cancel()
        resolve(TIMEOUT as R)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
