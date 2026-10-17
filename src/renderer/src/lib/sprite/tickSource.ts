/**
 * The tick source: the one thing that wakes the frame clock (NFR-TIM-10; ISSUE-282).
 *
 * A port, so the clock never reads a global clock or sets a global timer itself: the app gives it
 * `browserTickSource()` (timerTickSource.ts, the only file that sets a timer for sprite frames),
 * and tests give it `FakeTickSource` (testing/FakeTickSource.ts), whose time only moves when told.
 *
 * It is asked for ONE tick at a time, aimed at the earliest frame change among every sprite on the
 * clock — never a fixed-rate loop. A `requestAnimationFrame` loop was weighed and rejected: it would
 * wake a window of idle dwarfs sixty times a second to change nothing, where the foreman's sleep
 * changes frame a few times a second (motion.md, Sprites and idle cost; NFR-PERF-04).
 */
export interface TickSource {
  /** The source's clock, in milliseconds. */
  now(): number
  /** Runs `tick` once, `ms` from now; returns a handle for `clearTimer`. */
  setTimer(tick: () => void, ms: number): unknown
  /** Cancels a tick not yet run; a handle already run or cancelled is ignored. */
  clearTimer(handle: unknown): void
}
