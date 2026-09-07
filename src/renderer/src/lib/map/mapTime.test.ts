import { describe, expect, it } from 'vitest'
import { MAP_TIME_REFRESH_MS, MAP_TIME_VARIANTS, mapVariantAt } from './mapTime'

/** Local midday on an arbitrary fixed day; only the clock time is under test. */
function at(hours: number, minutes = 0): Date {
  return new Date(2026, 8, 3, hours, minutes, 0, 0)
}

describe('mapVariantAt', () => {
  /*
    The design's table, read as four closed ranges. Every boundary is checked
    from BOTH sides, because an off-by-one hour here is invisible for 23 hours
    a day and the table is the only place the answer is written down.

    AMENDED for #289 (was: day ended 15:59, sunset began 16:00). The maintainer
    moved sunset to 17:00 on 2026-09-07 after seeing the map go orange at 16:19
    in broad daylight; the design source's table carries the amendment.
  */
  it.each([
    ['morning', 7, 0],
    ['morning', 9, 30],
    ['morning', 11, 59],
    ['day', 12, 0],
    ['day', 12, 34],
    ['day', 16, 59],
    ['sunset', 17, 0],
    ['sunset', 18, 15],
    ['sunset', 19, 59],
    ['night', 20, 0],
    ['night', 23, 59],
    ['night', 0, 0],
    ['night', 3, 45],
    ['night', 6, 59]
  ])('reads %s at %i:%i', (variant, hours, minutes) => {
    expect(mapVariantAt(at(hours, minutes))).toBe(variant)
  })

  /*
    The design states this one outright — "At 12:34, the day variant is
    expected" — so it is pinned as its own case rather than left to the table
    above, where it would be one row among fourteen.
  */
  it('reads day at the 12:34 the design names', () => {
    expect(mapVariantAt(at(12, 34))).toBe('day')
  })

  it('answers with one of the four named variants at every minute of the day', () => {
    for (let hours = 0; hours < 24; hours++) {
      for (const minutes of [0, 1, 30, 59]) {
        expect(MAP_TIME_VARIANTS).toContain(mapVariantAt(at(hours, minutes)))
      }
    }
  })

  it('never leaves a gap: the four variants each own a whole number of hours', () => {
    const hoursPerVariant = new Map<string, number>()
    for (let hours = 0; hours < 24; hours++) {
      const variant = mapVariantAt(at(hours, 0))
      hoursPerVariant.set(variant, (hoursPerVariant.get(variant) ?? 0) + 1)
    }
    // AMENDED for #289 (was: day 4, sunset 4): sunset starts at 17:00, so the day owns
    // one more hour and the sunset one fewer; night and morning are untouched.
    expect([...hoursPerVariant.entries()].sort()).toEqual([
      ['day', 5],
      ['morning', 5],
      ['night', 11],
      ['sunset', 3]
    ])
  })

  it('reads the local clock, not UTC', () => {
    /*
      Same instant, asked as a Date: the function must use the local-time
      getters. A UTC reading would answer for a different hour on every host
      whose offset is not zero, and the design says "the user's local time".
    */
    const local = at(21, 0)
    expect(mapVariantAt(local)).toBe('night')
    expect(local.getHours()).toBe(21)
  })
})

describe('MAP_TIME_REFRESH_MS', () => {
  /*
    The design marks refresh cadence Unspecified. What this pins is the shape of
    the decision, not the number: a cadence measured in minutes, so a boundary
    is never more than one tick late, and never a single long timeout to the
    next boundary — a laptop that sleeps through 20:00 wakes owing the switch,
    and a timer that only ticks once will not pay it.
  */
  it('rechecks within a minute rather than sleeping until the next boundary', () => {
    expect(MAP_TIME_REFRESH_MS).toBeGreaterThan(0)
    expect(MAP_TIME_REFRESH_MS).toBeLessThanOrEqual(60_000)
  })
})
