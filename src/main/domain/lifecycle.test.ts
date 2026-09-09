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

/**
 * Retirement (issue #46). A kick that was OBSERVED to stop its agent takes the
 * dwarf off the board. The provider knows nothing about that observation and
 * goes on reporting the session for as long as its own rules say it is there,
 * so the decision has to be held here or every poll would re-adopt the dwarf.
 */
describe('DwarfLifecycleTracker retirement', () => {
  const dwarf = { ...defaultDwarf(), id: 'claude:a', name: 'Digger', status: 'working' as const }

  it('walks a retired dwarf out instead of blinking it away', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const reported = [mine({ dwarfs: [dwarf] })]
    tracker.apply(reported)

    now += 1_000
    tracker.retire('claude:a')
    // The provider still reports it working: the retirement is the panel's
    // observation, not the provider's.
    const result = tracker.apply(reported)
    expect(result[0]!.dwarfs).toHaveLength(1)
    expect(result[0]!.dwarfs[0]).toMatchObject({
      id: 'claude:a',
      name: 'Digger',
      status: 'leaving'
    })
  })

  it('keeps a retired dwarf gone while the provider goes on reporting it', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const reported = [mine({ dwarfs: [dwarf] })]
    tracker.apply(reported)

    now += 1_000
    tracker.retire('claude:a')
    tracker.apply(reported)

    now += GRACE_MS
    expect(tracker.apply(reported)[0]!.dwarfs).toEqual([])
    // The whole point of the record: a later poll carrying the same session
    // must not put the dwarf back on the rock.
    now += 60_000
    expect(tracker.apply(reported)[0]!.dwarfs).toEqual([])
  })

  it('leaves every dwarf that was not retired exactly where it was', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const other = { ...defaultDwarf(), id: 'claude:b', status: 'working' as const }
    tracker.apply([mine({ dwarfs: [dwarf, other] })])

    now += 1_000
    tracker.retire('claude:a')
    const result = tracker.apply([mine({ dwarfs: [dwarf, other] })])
    expect(result[0]!.dwarfs).toContainEqual(other)
  })

  it('forgets the retirement once the provider itself stops reporting the dwarf', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const reported = [mine({ dwarfs: [dwarf] })]
    tracker.apply(reported)

    now += 1_000
    tracker.retire('claude:a')
    tracker.apply(reported)
    now += GRACE_MS
    expect(tracker.apply(reported)[0]!.dwarfs).toEqual([])

    // The provider now agrees the session ended, so the record has nothing
    // left to suppress.
    now += 1_000
    tracker.apply([mine({ dwarfs: [] })])
    now += GRACE_MS
    tracker.apply([mine({ dwarfs: [] })])

    // A session that genuinely comes back under this id is real again: an
    // agent hidden while it is running is the lie #46 exists to prevent.
    now += 1_000
    const resumed = { ...defaultDwarf(), id: 'claude:a', status: 'working' as const }
    expect(tracker.apply([mine({ dwarfs: [resumed] })])[0]!.dwarfs).toEqual([resumed])
  })

  it('ignores a retirement for a dwarf it has never seen', () => {
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => 0 })
    tracker.retire('claude:ghost')
    const input = [mine({ dwarfs: [dwarf] })]
    expect(tracker.apply(input)).toEqual(input)
  })
})

/**
 * Dismissal (#293). A kick on a dwarf nothing here can interrupt — a Codex
 * thread's queue, a protocol with no cancel, a session that has already ended
 * — is the PERSON saying they are done with it, never the panel claiming the
 * session stopped. So it walks off the rock like a retirement, and unlike one
 * it comes straight back the moment the session is seen moving again: #46's
 * own warning is that an agent hidden while it runs is the very lie this
 * feature exists to prevent, and a dismissed session is usually still alive.
 */
describe('DwarfLifecycleTracker dismissal', () => {
  const idle = { ...defaultDwarf(), id: 'codex:a', name: 'Digger', status: 'waiting' as const }

  it('walks a dismissed dwarf out and keeps it off the board while it stays idle', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const reported = [mine({ dwarfs: [idle] })]
    tracker.apply(reported)

    now += 1_000
    tracker.dismiss('codex:a')
    const walking = tracker.apply(reported)
    expect(walking[0]!.dwarfs[0]).toMatchObject({ id: 'codex:a', status: 'leaving' })

    // The provider goes on reporting the idle thread for as long as its own
    // rules say it is there; that must not put the dwarf back on the rock.
    now += GRACE_MS
    expect(tracker.apply(reported)[0]!.dwarfs).toEqual([])
    now += 60_000
    expect(tracker.apply(reported)[0]!.dwarfs).toEqual([])
  })

  it('puts the dwarf back the moment the provider reports a turn open again', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    tracker.apply([mine({ dwarfs: [idle] })])

    now += 1_000
    tracker.dismiss('codex:a')
    // It walks out with the ordinary leaving grace before it is gone.
    const walking = tracker.apply([mine({ dwarfs: [idle] })])
    expect(walking[0]!.dwarfs[0]).toMatchObject({ id: 'codex:a', status: 'leaving' })
    now += GRACE_MS
    expect(tracker.apply([mine({ dwarfs: [idle] })])[0]!.dwarfs).toEqual([])

    // Somebody typed into that Codex TUI: the thread opens a turn.
    now += 1_000
    const working = { ...idle, status: 'working' as const }
    expect(tracker.apply([mine({ dwarfs: [working] })])[0]!.dwarfs).toEqual([working])
  })

  it('puts the dwarf back when its own transcript is appended to after the dismissal', () => {
    let now = 5_000
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const before = { ...idle, transcriptUpdatedAt: 4_000 }
    tracker.apply([mine({ dwarfs: [before] })])

    now += 1_000 // dismissed at t=6_000
    tracker.dismiss('codex:a')
    tracker.apply([mine({ dwarfs: [before] })])
    now += GRACE_MS // the walk is over
    // The same mtime it already had proves nothing: nobody has written since.
    expect(tracker.apply([mine({ dwarfs: [before] })])[0]!.dwarfs).toEqual([])

    // Measured against the DISMISSAL, not against now: a write at t=7_500 is
    // still a write somebody made after the person sent the dwarf off.
    now += 1_000
    const appended = { ...idle, transcriptUpdatedAt: 7_500 }
    expect(tracker.apply([mine({ dwarfs: [appended] })])[0]!.dwarfs).toEqual([appended])
  })

  it('reads a transcript written before the dismissal as no activity at all', () => {
    let now = 10_000
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const stale = { ...idle, transcriptUpdatedAt: 9_000 }
    tracker.apply([mine({ dwarfs: [stale] })])

    now += 1_000
    tracker.dismiss('codex:a')
    tracker.apply([mine({ dwarfs: [stale] })])
    now += GRACE_MS
    for (let i = 0; i < 5; i++) {
      now += 1_000
      expect(tracker.apply([mine({ dwarfs: [stale] })])[0]!.dwarfs).toEqual([])
    }
  })

  it('never reads a sibling dwarf’s work as the dismissed one moving', () => {
    // The mine's own updatedAt is deliberately NOT the evidence: several
    // sessions share one folder, so a neighbour digging would resurrect a
    // dwarf nobody touched.
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const other = { ...defaultDwarf(), id: 'codex:b', status: 'working' as const }
    tracker.apply([mine({ dwarfs: [idle, other] })])

    now += 1_000
    tracker.dismiss('codex:a')
    tracker.apply([mine({ dwarfs: [idle, other] })])
    now += GRACE_MS
    const result = tracker.apply([mine({ dwarfs: [idle, other], updatedAt: now })])
    expect(result[0]!.dwarfs.map((item) => item.id)).toEqual(['codex:b'])
  })

  it('ends the walk at once for a dwarf that was already leaving', () => {
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    tracker.apply([mine({ dwarfs: [idle] })])

    now += 1_000
    expect(tracker.apply([mine({ dwarfs: [] })])[0]!.dwarfs).toHaveLength(1)

    // Pressed on a finished worker: the walk is the thing being dismissed.
    now += 1_000
    tracker.dismiss('codex:a')
    expect(tracker.apply([mine({ dwarfs: [] })])[0]?.dwarfs ?? []).toEqual([])
  })

  it('leaves an observed stop suppressed however busy the provider says it is', () => {
    // #46's rule is untouched: a retirement is the panel having SEEN the agent
    // stop, so the provider still calling it 'working' is exactly the belief
    // the record exists to outlast.
    let now = 0
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => now })
    const busy = { ...idle, status: 'working' as const, transcriptUpdatedAt: 50_000 }
    tracker.apply([mine({ dwarfs: [busy] })])

    now += 1_000
    tracker.retire('codex:a')
    tracker.apply([mine({ dwarfs: [busy] })])
    now += GRACE_MS
    expect(tracker.apply([mine({ dwarfs: [busy] })])[0]!.dwarfs).toEqual([])
    now += 60_000
    expect(tracker.apply([mine({ dwarfs: [busy] })])[0]!.dwarfs).toEqual([])
  })

  it('ignores a dismissal for a dwarf it has never seen', () => {
    const tracker = new DwarfLifecycleTracker({ graceMs: GRACE_MS, now: () => 0 })
    tracker.dismiss('codex:ghost')
    const input = [mine({ dwarfs: [idle] })]
    expect(tracker.apply(input)).toEqual(input)
  })
})
