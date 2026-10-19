// The Clock double (16 §3: a mutable now, advanced by hand — house idiom). It never reads real
// time: `now()` changes only through `advance`, which also drives every attached FakeScheduler.
import type { Instant } from '../domain/values'
import type { Clock } from '../ports/clock'

/** Work that falls due as the clock passes instants (FakeScheduler attaches itself). */
export interface ClockDriven {
  /** The earliest instant something is due, or null when nothing is pending. */
  nextDueAt(): Instant | null
  /** Runs the work due at `now` (called with the clock already moved to `now`). */
  runDue(now: Instant): void
}

export class FakeClock implements Clock {
  private current: Instant
  private readonly driven = new Set<ClockDriven>()

  constructor(start: Instant = 0) {
    this.current = start
  }

  now(): Instant {
    return this.current
  }

  /**
   * Moves the clock forward by `ms`, stopping at each due instant on the way so that work runs
   * in due order and sees `now()` equal to its due instant; work scheduled meanwhile that falls
   * inside the window runs in the same call.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`FakeClock.advance needs a finite, non-negative ms; got ${ms}`)
    }
    const target = this.current + ms
    for (;;) {
      const next = this.earliestDue(target)
      if (next === null) break
      this.current = next.at
      next.driven.runDue(next.at)
    }
    this.current = target
  }

  attach(driven: ClockDriven): void {
    this.driven.add(driven)
  }

  private earliestDue(limit: Instant): { at: Instant; driven: ClockDriven } | null {
    let earliest: { at: Instant; driven: ClockDriven } | null = null
    for (const driven of this.driven) {
      const at = driven.nextDueAt()
      if (at !== null && at <= limit && (earliest === null || at < earliest.at)) {
        earliest = { at, driven }
      }
    }
    return earliest
  }
}
