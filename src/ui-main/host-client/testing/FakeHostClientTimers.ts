// A manual clock and timer queue for HostClient tests (17 §2.2: no real timers in the deterministic layers). `advance`
// moves the clock and runs every timer that falls due, in order. Never imported by production code (R14).
import type { HostClientTimers } from '../HostClient'

export class FakeHostClientTimers implements HostClientTimers {
  private at = 0
  private nextId = 0
  private readonly queue = new Map<number, { due: number; run: () => void }>()

  now = (): number => this.at

  after = (ms: number, run: () => void): (() => void) => {
    this.nextId += 1
    const id = this.nextId
    this.queue.set(id, { due: this.at + ms, run })
    return () => this.queue.delete(id)
  }

  /** Moves the clock by `ms`, running each due timer at its own time. */
  advance(ms: number): void {
    const end = this.at + ms
    for (;;) {
      let first: [number, { due: number; run: () => void }] | undefined
      for (const entry of this.queue) {
        if (entry[1].due <= end && (first === undefined || entry[1].due < first[1].due))
          first = entry
      }
      if (first === undefined) break
      this.queue.delete(first[0])
      this.at = Math.max(this.at, first[1].due)
      first[1].run()
    }
    this.at = end
  }

  /** How many timers wait. */
  pending(): number {
    return this.queue.size
  }
}
