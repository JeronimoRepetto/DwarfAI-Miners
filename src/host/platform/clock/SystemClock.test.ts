import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SystemClock } from './SystemClock'
import { runClockContract } from '../../kernel/testing/clock.contract'

describe('SystemClock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('[ADR-004] now is the system wall clock in epoch milliseconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 8, 30, 12, 0, 0))
    const clock = new SystemClock()

    expect(clock.now()).toBe(Date.UTC(2026, 8, 30, 12, 0, 0))
    vi.advanceTimersByTime(1_500)
    expect(clock.now()).toBe(Date.UTC(2026, 8, 30, 12, 0, 1, 500))
  })
})

describe('SystemClock under faked system time', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 9, 2, 9, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  runClockContract(() => ({
    clock: new SystemClock(),
    advance: (ms) => vi.advanceTimersByTime(ms)
  }))
})
