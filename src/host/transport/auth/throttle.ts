// The failed-hello throttle of the UI endpoint (ADR-003 item 5, frozen; 14 §1.5; 18 T-16, C-11):
// after 5 failed `hello`s within 60 s the Host refuses new connections for 10 s, each with one
// `error {code:'RATE_LIMITED'}` frame and the close, so a local flood cannot exhaust it.
//
// A pure counter on the injected Clock: the failure instants inside a sliding 60 s window (a
// failure exactly 60 s old has left it). The failure that brings the count to 5 starts the 10 s
// refusal and spends the window, so the throttle engages again only after 5 new failures; a
// connection refused while it is engaged is not a failure.
import type { Instant } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'

/** Failures within the window that start a refusal (ADR-003 item 5). */
export const THROTTLE_FAILURES = 5
/** The sliding window the failures are counted in. */
export const THROTTLE_WINDOW_MS = 60_000
/** How long new connections are refused once the throttle engages. */
export const THROTTLE_REFUSAL_MS = 10_000

/** What one failure did: nothing yet, or engaged the refusal after `count` failures. */
export type FailureVerdict = { engaged: false } | { engaged: true; count: number }

export class HelloThrottle {
  private failures: Instant[] = []
  private refusedUntil: Instant | null = null

  constructor(private readonly clock: Clock) {}

  /** Counts one failed hello at now. */
  recordFailure(): FailureVerdict {
    const now = this.clock.now()
    this.failures = this.failures.filter((at) => now - at < THROTTLE_WINDOW_MS)
    this.failures.push(now)
    if (this.failures.length < THROTTLE_FAILURES) return { engaged: false }
    const count = this.failures.length
    this.failures = []
    this.refusedUntil = now + THROTTLE_REFUSAL_MS
    return { engaged: true, count }
  }

  /** Whether a new connection is accepted now (false during a refusal). */
  admits(): boolean {
    return this.refusedUntil === null || this.clock.now() >= this.refusedUntil
  }
}
