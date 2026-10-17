/**
 * The window as a tick source (ISSUE-282): its wall clock and one timer. The only file in the
 * renderer that sets a timer driving sprite frames (`noTimers.test.ts` holds it to that).
 *
 * Every call reaches the global at the moment it is made, never a reference kept from before, so a
 * test's fake timers are the timers.
 */
import type { TickSource } from './tickSource'

export function browserTickSource(): TickSource {
  return {
    now: () => Date.now(),
    setTimer: (tick, ms) => globalThis.setTimeout(tick, ms),
    clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}
