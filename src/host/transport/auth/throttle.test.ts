// layer: L1
// The failed-hello throttle of ADR-003 item 5 (frozen; 14 §1.5; 18 C-11): five failures within a
// sliding 60 s window refuse new connections for 10 s, on the injected clock.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { HelloThrottle, THROTTLE_REFUSAL_MS } from './throttle'

/** Records one failure at each instant (ms from the start), in order; returns the verdicts. */
function failAt(clock: FakeClock, throttle: HelloThrottle, instants: number[]) {
  const start = clock.now()
  return instants.map((at) => {
    clock.advance(start + at - clock.now())
    return throttle.recordFailure()
  })
}

describe('HelloThrottle (ADR-003 item 5)', () => {
  it('[ADR-003, FM-027] four failures in 60 s do not throttle; the fifth does, for 10 s', () => {
    const clock = new FakeClock(1_000)
    const throttle = new HelloThrottle(clock)
    const verdicts = failAt(clock, throttle, [0, 10_000, 20_000, 30_000])
    expect(verdicts).toEqual(Array(4).fill({ engaged: false }))
    expect(throttle.admits()).toBe(true)

    clock.advance(10_000)
    expect(throttle.recordFailure()).toEqual({ engaged: true, count: 5 })
    expect(throttle.admits()).toBe(false)
    clock.advance(THROTTLE_REFUSAL_MS - 1)
    expect(throttle.admits()).toBe(false)
    clock.advance(1)
    expect(throttle.admits()).toBe(true)
  })

  it('[ADR-003] failures older than 60 s leave the window', () => {
    const clock = new FakeClock(1_000)
    const throttle = new HelloThrottle(clock)
    // At 60 s the first failure is exactly 60 s old: out of the window, so only four remain.
    const verdicts = failAt(clock, throttle, [0, 15_000, 30_000, 45_000, 60_000])
    expect(verdicts).toEqual(Array(5).fill({ engaged: false }))
    expect(throttle.admits()).toBe(true)
    // At 61 s: 15, 30, 45, 60 and 61 s are inside it.
    clock.advance(1_000)
    expect(throttle.recordFailure()).toEqual({ engaged: true, count: 5 })
    expect(throttle.admits()).toBe(false)
  })

  it('[ADR-003, FM-027] a refusal spends its failures: after the 10 s, one more failure does not throttle again', () => {
    const clock = new FakeClock(1_000)
    const throttle = new HelloThrottle(clock)
    failAt(clock, throttle, [0, 1_000, 2_000, 3_000, 4_000])
    expect(throttle.admits()).toBe(false)
    clock.advance(THROTTLE_REFUSAL_MS)
    expect(throttle.admits()).toBe(true)
    expect(throttle.recordFailure()).toEqual({ engaged: false })
    expect(throttle.admits()).toBe(true)
  })
})
