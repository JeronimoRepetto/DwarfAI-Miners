import type { ModeTiming } from '../modeTiming'

interface Pending {
  due: number
  fire: () => void
}

/**
 * Hand-written double of `ModeTiming` (16 §2.8; ISSUE-284): a clock that moves only when a test calls `advance`, which
 * runs every timer that fell due, in due order. It passes `runModeTimingContract`.
 */
export class FakeModeTiming implements ModeTiming {
  private readonly pending = new Set<Pending>()

  constructor(private clock = 1_000) {}

  now(): number {
    return this.clock
  }

  after(ms: number, fire: () => void): () => void {
    const timer: Pending = { due: this.clock + ms, fire }
    this.pending.add(timer)
    return () => {
      this.pending.delete(timer)
    }
  }

  /** Lets `ms` pass, running each timer when the clock reaches its due time. */
  advance(ms: number): void {
    const end = this.clock + ms
    for (;;) {
      const next = [...this.pending]
        .filter((timer) => timer.due <= end)
        .sort((a, b) => a.due - b.due)[0]
      if (next === undefined) break
      this.pending.delete(next)
      this.clock = next.due
      next.fire()
    }
    this.clock = end
  }

  /** How many timers are armed and not yet run or cancelled. */
  get armed(): number {
    return this.pending.size
  }
}
