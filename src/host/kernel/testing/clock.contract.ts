// The Clock conformance suite (16 §2.8, §3 row `Clock`; 17 §1.3): run against FakeClock and SystemClock. `now()` is
// the one time source of every Host module, in epoch milliseconds. Monotonic ordering is not promised (ordering comes
// from commit order, 08 §5.2), so the suite asserts only what the port promises. Time moves only through the subject's
// own `advance`, so no real timer runs here (L3).
import { describe, expect, it } from 'vitest'
import type { Clock } from '../ports/clock'

export interface ClockSubject {
  clock: Clock
  /** Lets `ms` of time pass for the subject (the double by hand, the real clock through faked system time). */
  advance(ms: number): void
}

export function runClockContract(makeSubject: () => ClockSubject): void {
  describe('Clock contract', () => {
    it('[ADR-004] now() is an instant in epoch milliseconds: a non-negative whole number', () => {
      const { clock } = makeSubject()

      const now = clock.now()

      expect(Number.isSafeInteger(now)).toBe(true)
      expect(now).toBeGreaterThanOrEqual(0)
    })

    it('[ADR-004] reading now() does not move it: reads with no time passing are equal', () => {
      const { clock } = makeSubject()

      const reads = [clock.now(), clock.now(), clock.now()]

      expect(new Set(reads).size).toBe(1)
    })

    it('[ADR-004] now() moves by exactly the time that passed', () => {
      const { clock, advance } = makeSubject()
      const before = clock.now()

      advance(1)
      const afterOne = clock.now()
      advance(59_999)

      expect(afterOne - before).toBe(1)
      expect(clock.now() - before).toBe(60_000)
    })
  })
}
