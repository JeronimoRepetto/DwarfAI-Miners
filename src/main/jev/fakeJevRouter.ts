import type {
  JevModelRouteOutcome,
  JevModelRouteRequest,
  JevRouteOutcome,
  JevRouteRequest,
  JevRouterPort
} from './jevRouterPort'

/**
 * Scripted JevRouterPort for T3/T4's tests — no network, no SDK, in the same
 * idiom as adapters/fakeFs.ts: a test registers exactly the outcomes it
 * wants before calling code runs, rather than this fake inventing one.
 * #608 extends it with the identical shape for the second request
 * (`queueModelOutcome`/`modelRequestsSeen`/`routeModel`) — a separate queue
 * and a separate request log, so a test that only ever sends request 1 sees
 * no change and a test exercising request 2 can assert on it in isolation.
 */
export class FakeJevRouter implements JevRouterPort {
  private readonly outcomes: JevRouteOutcome[] = []
  private readonly requests: JevRouteRequest[] = []
  private readonly modelOutcomes: JevModelRouteOutcome[] = []
  private readonly modelRequests: JevModelRouteRequest[] = []

  /** Queues the next outcome `route` returns, in call order. */
  queueOutcome(outcome: JevRouteOutcome): void {
    this.outcomes.push(outcome)
  }

  /** Queues the next outcome `routeModel` returns, in call order (#608). */
  queueModelOutcome(outcome: JevModelRouteOutcome): void {
    this.modelOutcomes.push(outcome)
  }

  /**
   * Every request `route` was actually called with, in call order — so a
   * test can assert what a launch sent Jev without re-deriving it.
   */
  requestsSeen(): readonly JevRouteRequest[] {
    return this.requests
  }

  /** Every request `routeModel` was actually called with, in call order (#608). */
  modelRequestsSeen(): readonly JevModelRouteRequest[] {
    return this.modelRequests
  }

  async route(
    request: JevRouteRequest,
    _options: { signal?: AbortSignal }
  ): Promise<JevRouteOutcome> {
    this.requests.push(request)
    const next = this.outcomes.shift()
    // Loud rather than a silent default: a test that forgot to queue an
    // outcome has a gap in its own setup, not a real fallback to report.
    if (next === undefined) {
      throw new Error('FakeJevRouter: route() called with no outcome queued')
    }
    return next
  }

  async routeModel(
    request: JevModelRouteRequest,
    _options: { signal?: AbortSignal }
  ): Promise<JevModelRouteOutcome> {
    this.modelRequests.push(request)
    const next = this.modelOutcomes.shift()
    if (next === undefined) {
      throw new Error('FakeJevRouter: routeModel() called with no outcome queued')
    }
    return next
  }
}
