import type { JevRouteOutcome, JevRouteRequest, JevRouterPort } from './jevRouterPort'

/**
 * Scripted JevRouterPort for T3/T4's tests — no network, no SDK, in the same
 * idiom as adapters/fakeFs.ts: a test registers exactly the outcomes it
 * wants before calling code runs, rather than this fake inventing one.
 */
export class FakeJevRouter implements JevRouterPort {
  private readonly outcomes: JevRouteOutcome[] = []
  private readonly requests: JevRouteRequest[] = []

  /** Queues the next outcome `route` returns, in call order. */
  queueOutcome(outcome: JevRouteOutcome): void {
    this.outcomes.push(outcome)
  }

  /**
   * Every request `route` was actually called with, in call order — so a
   * test can assert what a launch sent Jev without re-deriving it.
   */
  requestsSeen(): readonly JevRouteRequest[] {
    return this.requests
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
}
