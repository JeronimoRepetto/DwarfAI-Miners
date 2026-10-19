import { afterEach, beforeEach, describe, vi } from 'vitest'
import { runSchedulerContract } from '../../kernel/testing/scheduler.contract'
import { NodeScheduler } from './NodeScheduler'

describe('NodeScheduler', () => {
  // L3 runs no real timer (17 §1.1): Vitest's fake timers stand in for setTimeout.
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  runSchedulerContract(({ onTaskError }) => ({
    scheduler: new NodeScheduler({ onTaskError }),
    advance: (ms) => {
      vi.advanceTimersByTime(ms)
    }
  }))
})
