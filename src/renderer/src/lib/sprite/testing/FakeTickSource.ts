/**
 * A scriptable tick source for the frame clock's tests (ISSUE-282; `17` §2.2 `Fake<Port>`).
 *
 * Time is a number the test moves; every tick the clock asks for is counted, so a test can say how
 * many frames were requested, and how many are waiting, as well as which frame each sprite shows.
 * Never imported by production code (R14).
 */
import type { FrameClockEnv } from '../frameClock'
import type { TickSource } from '../tickSource'

interface PendingTick {
  readonly id: number
  readonly at: number
  readonly tick: () => void
}

export class FakeTickSource implements TickSource {
  /** The current time, in milliseconds. */
  t = 0
  /** Every tick ever asked for, cancelled ones included. */
  requests = 0
  private seq = 0
  private queue: PendingTick[] = []

  now(): number {
    return this.t
  }

  setTimer(tick: () => void, ms: number): unknown {
    this.requests++
    const id = ++this.seq
    this.queue.push({ id, at: this.t + Math.max(0, ms), tick })
    return id
  }

  clearTimer(handle: unknown): void {
    this.queue = this.queue.filter((pending) => pending.id !== handle)
  }

  /** How many ticks are asked for and not yet run. */
  get pending(): number {
    return this.queue.length
  }

  /** When the next tick is due, or undefined where none is asked for. */
  get nextAt(): number | undefined {
    return this.queue.reduce<number | undefined>(
      (earliest, pending) =>
        earliest === undefined || pending.at < earliest ? pending.at : earliest,
      undefined
    )
  }

  /** Moves time to the next tick and runs it; false where none is asked for. */
  runNext(): boolean {
    const at = this.nextAt
    if (at === undefined) return false
    const due = this.queue.find((pending) => pending.at === at)!
    this.queue = this.queue.filter((pending) => pending !== due)
    this.t = at
    due.tick()
    return true
  }

  /** Moves time forward by `ms`, running every tick that falls due on the way, in order. */
  advance(ms: number): void {
    const end = this.t + ms
    for (let at = this.nextAt; at !== undefined && at <= end; at = this.nextAt) this.runNext()
    this.t = end
  }
}

/** Host state a test can flip: visibility and the reduced-motion preference. */
export interface FakeFrameClockHost {
  hidden: boolean
  reducedMotion: boolean
  /** Tells the clock the visibility changed, as the document's event would. */
  setHidden(hidden: boolean): void
}

/** A whole frame clock environment on `ticks`: visible, full motion, phase drawn at 0. */
export function fakeFrameClockEnv(ticks: FakeTickSource): {
  env: FrameClockEnv
  host: FakeFrameClockHost
} {
  const visibility = new Set<() => void>()
  const host: FakeFrameClockHost = {
    hidden: false,
    reducedMotion: false,
    setHidden(hidden) {
      host.hidden = hidden
      for (const listener of [...visibility]) listener()
    }
  }
  const env: FrameClockEnv = {
    now: () => ticks.now(),
    setTimer: (tick, ms) => ticks.setTimer(tick, ms),
    clearTimer: (handle) => ticks.clearTimer(handle),
    hidden: () => host.hidden,
    onVisibilityChange(listener) {
      visibility.add(listener)
      return () => visibility.delete(listener)
    },
    reducedMotion: () => host.reducedMotion,
    onReducedMotionChange: () => () => {},
    random: () => 0
  }
  return { env, host }
}
