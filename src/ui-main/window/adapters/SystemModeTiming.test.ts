import { afterEach, beforeEach, vi } from 'vitest'
import { runModeTimingContract } from '../ports/modeTiming.contract'
import { SystemModeTiming } from './SystemModeTiming'

// The real adapter over the process clock and `setTimeout`, driven by Vitest's fake timers (no real timers, 17 §5.3).
beforeEach(() => {
  vi.useFakeTimers({ now: 1_000 })
})
afterEach(() => {
  vi.useRealTimers()
})

runModeTimingContract('SystemModeTiming', () => ({
  timing: new SystemModeTiming(),
  elapse: (ms) => vi.advanceTimersByTime(ms)
}))
