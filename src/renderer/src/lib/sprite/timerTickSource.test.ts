import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TickSource } from './tickSource'
import { browserTickSource } from './timerTickSource'

// ISSUE-282 (TC-282-03): the window's tick source, on Vitest's fake clock rather than real time.
describe('browserTickSource', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('[NFR-TIM-10] runs one tick once, when it falls due, and reads the window clock', () => {
    const ticks: TickSource = browserTickSource()
    const ran: number[] = []
    ticks.setTimer(() => ran.push(ticks.now()), 250)

    vi.advanceTimersByTime(249)
    expect(ran).toEqual([])
    vi.advanceTimersByTime(1)
    expect(ran).toEqual([1_250])
    vi.advanceTimersByTime(10_000)
    expect(ran).toEqual([1_250])
  })

  it('[NFR-TIM-10] a cancelled tick never runs', () => {
    const ticks = browserTickSource()
    const ran: string[] = []
    const handle = ticks.setTimer(() => ran.push('tick'), 100)
    ticks.clearTimer(handle)

    vi.advanceTimersByTime(1_000)
    expect(ran).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
