import { describe, expect, it } from 'vitest'
import type { ModeTiming } from './modeTiming'

export interface ModeTimingSubject {
  timing: ModeTiming
  /** Lets `ms` milliseconds of the subject's clock pass, running every timer due. */
  elapse(ms: number): void
}

/**
 * The `ModeTiming` contract (ISSUE-284; 17 §1.3), run by the double and by the real adapter alike: `now()` moves with
 * the clock and never goes back; `after(ms, fire)` runs `fire` exactly once, once `ms` milliseconds passed and not
 * before; its cancel keeps it from running.
 */
export function runModeTimingContract(name: string, make: () => ModeTimingSubject): void {
  describe(`${name} meets the ModeTiming contract`, () => {
    it('[S27.02] now moves with the clock and never goes back', () => {
      const subject = make()
      const start = subject.timing.now()
      subject.elapse(16)
      expect(subject.timing.now()).toBe(start + 16)
    })

    it('[S27.04, NFR-TIM-16] a one-shot timer fires once after its delay, never before', () => {
      const subject = make()
      let fired = 0
      subject.timing.after(310, () => (fired += 1))
      subject.elapse(309)
      expect(fired).toBe(0)
      subject.elapse(1)
      expect(fired).toBe(1)
      subject.elapse(1000)
      expect(fired).toBe(1)
    })

    it('[S27.04] a cancelled timer never fires', () => {
      const subject = make()
      let fired = 0
      const cancel = subject.timing.after(310, () => (fired += 1))
      cancel()
      subject.elapse(1000)
      expect(fired).toBe(0)
    })
  })
}
