import { describe, expect, it } from 'vitest'
import { FakeClock } from './FakeClock'
import { FakeScheduler } from './FakeScheduler'

const IDLE_TO_ASLEEP_MS = 60_000 // ADR-032: the idle → asleep timer, a Scheduler task on the Clock

describe('FakeClock', () => {
  it('[ADR-032] FakeClock only moves when advanced by hand and drives FakeScheduler', () => {
    const clock = new FakeClock(1_000)
    const scheduler = new FakeScheduler(clock)
    const firedAt: number[] = []
    scheduler.after(IDLE_TO_ASLEEP_MS, () => firedAt.push(clock.now()))

    expect(clock.now()).toBe(1_000)
    expect(clock.now()).toBe(1_000)

    clock.advance(IDLE_TO_ASLEEP_MS - 1)
    expect(clock.now()).toBe(1_000 + IDLE_TO_ASLEEP_MS - 1)
    expect(firedAt).toEqual([])

    clock.advance(5)
    expect(firedAt).toEqual([1_000 + IDLE_TO_ASLEEP_MS])
    expect(clock.now()).toBe(1_000 + IDLE_TO_ASLEEP_MS + 4)
  })
})
