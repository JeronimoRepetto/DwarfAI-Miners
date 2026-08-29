import { describe, expect, it } from 'vitest'
import { DwarfLifecycleTracker } from './lifecycle'
import { defaultDwarf, defaultMine, type Mine } from './types'

const GRACE_MS = 20_000

function mine(overrides: Partial<Mine> = {}): Mine {
  return { ...defaultMine(), id: 'mine:1', path: 'C:\\Proj', name: 'Proj', ...overrides }
}

describe('DwarfLifecycleTracker', () => {
  it('passes through mines unchanged when nothing disappears', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const dwarf = { ...defaultDwarf(), id: 'codex:a', status: 'working' as const }
    const input = [mine({ dwarfs: [dwarf] })]

    expect(tracker.apply(input)).toEqual(input)
    now += 1_000
    expect(tracker.apply(input)).toEqual(input)
  })

  it('keeps a disappeared dwarf visible with status leaving inside its still-present mine', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const dwarf = { ...defaultDwarf(), id: 'codex:a', name: 'Digger', status: 'working' as const }
    tracker.apply([mine({ dwarfs: [dwarf] })])

    now += 1_000
    const result = tracker.apply([mine({ dwarfs: [] })])
    expect(result).toHaveLength(1)
    expect(result[0]!.dwarfs).toHaveLength(1)
    expect(result[0]!.dwarfs[0]).toMatchObject({ id: 'codex:a', name: 'Digger', status: 'leaving' })
  })

  it('drops the leaving dwarf once the grace period elapses', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const dwarf = { ...defaultDwarf(), id: 'codex:a', status: 'working' as const }
    tracker.apply([mine({ dwarfs: [dwarf] })])

    now += 1_000
    const stillLeaving = tracker.apply([mine({ dwarfs: [] })])
    expect(stillLeaving[0]!.dwarfs).toHaveLength(1)

    now += GRACE_MS // total elapsed since missing: GRACE_MS, at the boundary
    const atBoundary = tracker.apply([mine({ dwarfs: [] })])
    expect(atBoundary[0]?.dwarfs ?? []).toHaveLength(0)
  })

  it('does not reset the grace timer on repeated ticks while still missing', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const dwarf = { ...defaultDwarf(), id: 'codex:a', status: 'working' as const }
    tracker.apply([mine({ dwarfs: [dwarf] })])

    // First missing observation at t=5_000 (missingSince=5_000). Keep polling
    // with no dwarf every 5s: if each tick reset the timer, it would never expire.
    for (let i = 0; i < 3; i++) {
      now += 5_000 // t = 5_000, 10_000, 15_000
      const result = tracker.apply([mine({ dwarfs: [] })])
      expect(result[0]!.dwarfs).toHaveLength(1)
    }
    // t=25_000: 20_000ms elapsed since missingSince=5_000 -> expired.
    now += 10_000
    const expired = tracker.apply([mine({ dwarfs: [] })])
    expect(expired[0]?.dwarfs ?? []).toHaveLength(0)
  })

  it('keeps a synthetic mine visible when the whole mine disappears, then drops it after grace', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const dwarf = { ...defaultDwarf(), id: 'codex:a', status: 'working' as const }
    tracker.apply([mine({ id: 'mine:gone', path: 'C:\\Gone', name: 'Gone', dwarfs: [dwarf] })])

    now += 1_000
    const result = tracker.apply([]) // the mine itself vanished (session closed)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'mine:gone', path: 'C:\\Gone', name: 'Gone' })
    expect(result[0]!.dwarfs[0]).toMatchObject({ id: 'codex:a', status: 'leaving' })

    now += GRACE_MS
    expect(tracker.apply([])).toEqual([])
  })

  it('treats a reappearing dwarf as real again instead of leaving', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const dwarf = { ...defaultDwarf(), id: 'codex:a', status: 'working' as const }
    tracker.apply([mine({ dwarfs: [dwarf] })])

    now += 1_000
    tracker.apply([mine({ dwarfs: [] })]) // now leaving

    now += 1_000
    const reappeared = { ...defaultDwarf(), id: 'codex:a', status: 'waiting' as const }
    const result = tracker.apply([mine({ dwarfs: [reappeared] })])
    expect(result[0]!.dwarfs).toEqual([reappeared])

    // It should no longer be tracked as leaving: disappearing again restarts the clock at now.
    now += 1_000
    const missingAgain = tracker.apply([mine({ dwarfs: [] })])
    expect(missingAgain[0]!.dwarfs[0]).toMatchObject({ status: 'leaving' })
    now += GRACE_MS - 1 // not yet at the new grace boundary
    expect(tracker.apply([mine({ dwarfs: [] })])[0]!.dwarfs).toHaveLength(1)
  })

  it('leaves multiple independent dwarfs and mines to expire on their own schedule', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const a = { ...defaultDwarf(), id: 'codex:a', status: 'working' as const }
    const b = { ...defaultDwarf(), id: 'codex:b', status: 'working' as const }
    tracker.apply([mine({ dwarfs: [a, b] })])

    now += 1_000
    tracker.apply([mine({ dwarfs: [a] })]) // b disappears first

    now += 10_000 // a disappears 10s after b
    const bothLeaving = tracker.apply([mine({ dwarfs: [] })])
    expect(bothLeaving[0]!.dwarfs.map((d) => d.id).sort()).toEqual(['codex:a', 'codex:b'])

    now += 10_000 // b's grace (20s since t=1000) expires at t=21000; a's at t=31000
    const onlyA = tracker.apply([mine({ dwarfs: [] })])
    expect(onlyA[0]!.dwarfs.map((d) => d.id)).toEqual(['codex:a'])
  })
})
