import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import {
  mapMarkerOf,
  mineIdOf,
  mineNameOf,
  openMine,
  transition,
  type Mine,
  type MineBirth,
  type MineInput,
  type MineState,
  type MineTransitionId
} from './mine'
import { canonicalMinePath } from './minePath'
import { DEFAULT_TIER_THRESHOLDS } from './tier'

const clock = new FakeClock(1_700_000_000_000)
const T0 = clock.now()
const LATER = T0 + 60_000

function birth(ids = new SequenceIdGenerator(), realPath = '/src/repo'): MineBirth {
  return {
    id: mineIdOf(ids.uuidv7()),
    path: canonicalMinePath(realPath, { style: 'posix', caseFold: false }),
    name: mineNameOf('repo')
  }
}

/** A mine created by observation (S3.01), then walked to `state` through machine 3 itself. */
function mineIn(state: MineState, opts: { measured?: boolean } = {}): Mine {
  let mine = openMine({ cause: 'first-message', birth: birth() }, T0).mine!
  const step = (input: MineInput): void => {
    const next = transition(mine, input, T0).mine
    if (next === null) throw new Error('fixture walk deleted the mine')
    mine = next
  }
  if (opts.measured === true || state === 'active') {
    step({ type: 'measurement-due' })
    step({
      type: 'measured',
      sourceWeight: { bytes: 400 * 1024 },
      thresholds: DEFAULT_TIER_THRESHOLDS
    })
  }
  if (state === 'unrecorded' || state === 'active') return mine
  if (state === 'measuring') {
    step(mine.state === 'active' ? { type: 'remeasure-requested' } : { type: 'measurement-due' })
    return mine
  }
  if (state === 'unenterable') {
    step({ type: 'folder-checked', folder: 'missing', reason: 'folder-missing' })
    return mine
  }
  step({ type: 'removal-requested' })
  step({ type: 'removal-settled', everyDwarfEnded: true })
  return mine
}

const observed = (
  over: Partial<Extract<MineInput, { type: 'session-observed' }>> = {}
): MineInput => ({
  type: 'session-observed',
  inLinkedWorktree: false,
  endedByTerminator: false,
  ...over
})

interface Row {
  readonly id: MineTransitionId
  readonly run: () => { mine: Mine | null; transition: MineTransitionId | null }
  /** The resulting state; null = no mine (never created, or deleted). */
  readonly state: MineState | null
  readonly check?: (mine: Mine | null) => void
}

// Machine 3 (07 §3), one row per transition id. A self-loop row (S3.03, S3.06, S3.15, S3.18, S3.22,
// S3.25) names the rule that holds the stored state.
const TABLE: readonly Row[] = [
  {
    id: 'S3.01',
    run: () => openMine({ cause: 'first-message', birth: birth() }, T0),
    state: 'unrecorded'
  },
  {
    id: 'S3.02',
    run: () => openMine({ cause: 'worktree-fold', birth: birth() }, T0),
    state: 'unrecorded'
  },
  {
    id: 'S3.03',
    run: () => transition(mineIn('active'), observed({ inLinkedWorktree: true }), LATER),
    state: 'active',
    check: (m) => expect(m?.lastUsedAt).toBe(LATER)
  },
  {
    id: 'S3.04',
    run: () => openMine({ cause: 'declared', birth: birth() }, T0),
    state: 'measuring'
  },
  {
    id: 'S3.05',
    run: () => openMine({ cause: 'adopted-main-project', birth: birth() }, T0),
    state: 'measuring'
  },
  {
    id: 'S3.06',
    run: () => transition(mineIn('active'), { type: 'main-project-adopted' }, LATER),
    state: 'active'
  },
  {
    id: 'S3.07',
    run: () => openMine({ cause: 'refused', reason: 'no-main-project' }, T0),
    state: null
  },
  {
    id: 'S3.08',
    run: () => transition(mineIn('unrecorded'), { type: 'measurement-due' }, LATER),
    state: 'measuring'
  },
  {
    id: 'S3.09',
    run: () =>
      transition(
        mineIn('measuring'),
        {
          type: 'measured',
          sourceWeight: { bytes: 2_000 * 1024 },
          thresholds: DEFAULT_TIER_THRESHOLDS
        },
        LATER
      ),
    state: 'active',
    check: (m) => {
      expect(m).toMatchObject({ tier: 'silver', hasBeenMeasured: true, measuredAt: LATER })
      expect(m?.sourceWeight).toEqual({ bytes: 2_000 * 1024 })
    }
  },
  {
    id: 'S3.10',
    run: () => transition(mineIn('active'), { type: 'remeasure-requested' }, LATER),
    state: 'measuring',
    // INV-05: the last tier and weight stay until the new walk completes.
    check: (m) => expect(m).toMatchObject({ tier: 'copper', sourceWeight: { bytes: 400 * 1024 } })
  },
  {
    id: 'S3.11',
    run: () =>
      transition(
        mineIn('measuring'),
        { type: 'walk-found-unenterable', reason: 'folder-missing' },
        LATER
      ),
    state: 'unenterable',
    check: (m) => expect(m?.unenterableReason).toBe('folder-missing')
  },
  {
    id: 'S3.12',
    run: () =>
      transition(
        mineIn('unrecorded'),
        { type: 'folder-checked', folder: 'missing', reason: 'folder-missing' },
        LATER
      ),
    state: 'unenterable'
  },
  {
    id: 'S3.13',
    run: () =>
      transition(
        mineIn('unenterable', { measured: true }),
        { type: 'folder-checked', folder: 'present' },
        LATER
      ),
    state: 'active',
    check: (m) => expect(m?.unenterableReason).toBeUndefined()
  },
  {
    id: 'S3.14',
    run: () =>
      transition(mineIn('unenterable'), { type: 'folder-checked', folder: 'present' }, LATER),
    state: 'measuring',
    check: (m) => expect(m?.unenterableReason).toBeUndefined()
  },
  {
    id: 'S3.15',
    run: () => transition(mineIn('measuring'), { type: 'removal-requested' }, LATER),
    // `removing` is a command in flight, never stored: the prior state stays underneath.
    state: 'measuring'
  },
  {
    id: 'S3.16',
    run: () =>
      transition(mineIn('active'), { type: 'removal-settled', everyDwarfEnded: true }, LATER),
    state: 'removed',
    check: (m) => expect(m?.removedAt).toBe(LATER)
  },
  {
    id: 'S3.17',
    run: () =>
      transition(mineIn('unenterable'), { type: 'removal-settled', everyDwarfEnded: false }, LATER),
    state: 'unenterable'
  },
  {
    id: 'S3.18',
    // A Host crash before the outcome: nothing was committed, so the next boot finds the prior state.
    run: () => {
      const before = mineIn('active')
      const requested = transition(before, { type: 'removal-requested' }, LATER)
      expect(requested.mine).toEqual(before)
      const booted = transition(requested.mine!, { type: 'host-booted' }, LATER)
      expect(booted).toEqual({ mine: before, transition: null })
      return { mine: booted.mine, transition: 'S3.18' }
    },
    state: 'active'
  },
  {
    id: 'S3.19',
    run: () => transition(mineIn('removed'), observed(), LATER),
    state: 'unrecorded'
  },
  {
    id: 'S3.20',
    run: () => transition(mineIn('removed', { measured: true }), { type: 'declared' }, LATER),
    state: 'active',
    check: (m) => {
      expect(m?.tier).toBe('copper')
      expect(m?.removedAt).toBeUndefined()
    }
  },
  {
    id: 'S3.21',
    run: () => transition(mineIn('removed'), { type: 'declared' }, LATER),
    state: 'measuring'
  },
  {
    id: 'S3.22',
    run: () => transition(mineIn('removed'), observed({ endedByTerminator: true }), LATER),
    state: 'removed'
  },
  {
    id: 'S3.23',
    run: () =>
      transition(mineIn('active'), { type: 'metrics-reset', hasPresentDwarf: false }, LATER),
    state: null
  },
  {
    id: 'S3.24',
    run: () =>
      transition(mineIn('active'), { type: 'metrics-reset', hasPresentDwarf: true }, LATER),
    state: 'measuring',
    check: (m) => {
      const prior = mineIn('active')
      expect(m).toMatchObject({ id: prior.id, path: prior.path, tier: null, sourceWeight: null })
      expect(m).toMatchObject({ hasBeenMeasured: false, createdAt: LATER })
      expect(m?.measuredAt).toBeUndefined()
    }
  },
  {
    id: 'S3.25',
    run: () => transition(mineIn('measuring'), { type: 'host-booted' }, LATER),
    state: 'measuring'
  }
]

describe('Mine aggregate: machine 3 (07 §3, 06 §4.1–§4.2)', () => {
  it("[S3.01, INV-04] an unknown folder's first message creates an unrecorded mine with no tier", () => {
    const b = birth()
    const { mine, transition: applied } = openMine({ cause: 'first-message', birth: b }, T0)
    expect(applied).toBe('S3.01')
    expect(mine).toEqual({
      id: b.id,
      path: b.path,
      name: 'repo',
      state: 'unrecorded',
      tier: null,
      sourceWeight: null,
      hasBeenMeasured: false,
      createdAt: T0,
      lastUsedAt: T0
    })
  })

  it('[S3.16, INV-06] removal completes only when every dwarf ended; S3.17 keeps the prior state otherwise', () => {
    for (const prior of ['unrecorded', 'measuring', 'active', 'unenterable'] as const) {
      const mine = mineIn(prior)
      const failed = transition(mine, { type: 'removal-settled', everyDwarfEnded: false }, LATER)
      expect(failed).toEqual({ mine, transition: 'S3.17' })
      const done = transition(mine, { type: 'removal-settled', everyDwarfEnded: true }, LATER)
      expect(done.transition).toBe('S3.16')
      expect(done.mine).toEqual({ ...mine, state: 'removed', removedAt: LATER })
    }
  })

  it('[S3.19, S3.20, INV-07] a removed mine found again keeps its id and returns unrecorded or active', () => {
    const neverMeasured = mineIn('removed')
    const rediscovered = transition(neverMeasured, observed(), LATER)
    expect(rediscovered.transition).toBe('S3.19')
    expect(rediscovered.mine).toMatchObject({
      id: neverMeasured.id,
      state: 'unrecorded',
      lastUsedAt: LATER
    })
    expect(rediscovered.mine?.removedAt).toBeUndefined()

    const measured = mineIn('removed', { measured: true })
    const back = transition(measured, observed(), LATER)
    expect(back.transition).toBe('S3.20')
    expect(back.mine).toMatchObject({ id: measured.id, state: 'active', tier: 'copper' })
    expect(back.mine?.removedAt).toBeUndefined()
  })

  it('[S3.22] a late write of an ended session leaves a removed mine removed', () => {
    for (const measured of [false, true]) {
      const removed = mineIn('removed', { measured })
      const late = transition(removed, observed({ endedByTerminator: true }), LATER)
      expect(late).toEqual({ mine: removed, transition: 'S3.22' })
      const lateInWorktree = transition(
        removed,
        observed({ endedByTerminator: true, inLinkedWorktree: true }),
        LATER
      )
      expect(lateInWorktree).toEqual({ mine: removed, transition: 'S3.22' })
    }
  })

  it("[INV-01] a created mine's id is a UUIDv7 from the injected IdGenerator and is never derived from its path", () => {
    const ids = new SequenceIdGenerator()
    const first = openMine({ cause: 'first-message', birth: birth(ids, '/src/repo') }, T0).mine!
    const second = openMine({ cause: 'declared', birth: birth(ids, '/src/repo') }, T0).mine!
    expect(first.id).toBe('00000000-0000-7000-8000-000000000001')
    expect(second.id).toBe('00000000-0000-7000-8000-000000000002')
    expect(first.path).toBe(second.path)
    // A path-derived id (today's `mineIdForPath`) or any other non-UUIDv7 is refused.
    for (const raw of ['mine:/src/repo', '/src/repo', '0192f0c1-7a2e-4c3d-9f00-5b1a2c3d4e5f', '']) {
      expect(() => mineIdOf(raw)).toThrow(HostInvariantError)
    }
  })

  it('[INV-09] a window close, a UI detach or a Reset metrics event other than the ADR-023 recreation is not a mine transition and changes no mine', () => {
    const notMineInputs = [
      { type: 'window-closed' },
      { type: 'ui-detached' },
      { type: 'MetricsResetFinished' },
      { type: 'metrics-reset-step', step: 'secrets' }
    ]
    for (const state of ['unrecorded', 'measuring', 'active', 'unenterable', 'removed'] as const) {
      const mine = mineIn(state)
      for (const input of notMineInputs) {
        expect(transition(mine, input as unknown as MineInput, LATER)).toEqual({
          mine,
          transition: null
        })
      }
    }
  })

  it("[US-MINES-006.AC07, INV-02] a new session in an existing mine's folder only adds a dwarf, never a second mine", () => {
    for (const state of ['unrecorded', 'measuring', 'active', 'unenterable'] as const) {
      const mine = mineIn(state)
      const result = transition(mine, observed(), LATER)
      expect(result).toEqual({ mine: { ...mine, lastUsedAt: LATER }, transition: null })
    }
  })

  it('[INV-08] unenterableReason is set exactly while a mine is unenterable', () => {
    for (const row of TABLE) {
      const { mine } = row.run()
      if (mine === null) continue
      expect(mine.unenterableReason !== undefined, row.id).toBe(mine.state === 'unenterable')
      expect(mine.removedAt !== undefined, row.id).toBe(mine.state === 'removed')
      expect(mine.tier === null || mine.hasBeenMeasured, row.id).toBe(true)
      expect(mine.hasBeenMeasured, row.id).toBe(mine.measuredAt !== undefined)
    }
  })

  it('[INV-08] the map marker is absent for a removed mine and says when a mine cannot be entered', () => {
    expect(mapMarkerOf(mineIn('removed'))).toBeNull()
    const active = mineIn('active')
    expect(mapMarkerOf(active)).toEqual({
      mineId: active.id,
      tier: 'copper',
      site: null,
      enterable: true
    })
    const away = mineIn('unenterable')
    expect(mapMarkerOf({ ...away, mapSite: { xPct: 12.5, yPct: 80 } })).toEqual({
      mineId: away.id,
      tier: null,
      site: { xPct: 12.5, yPct: 80 },
      enterable: false,
      unenterableReason: 'folder-missing'
    })
  })

  it('[S3.01, S3.02, S3.03, S3.04, S3.05, S3.06, S3.07, S3.08, S3.09, S3.10, S3.11, S3.12, S3.13, S3.14, S3.15, S3.16, S3.17, S3.18, S3.19, S3.20, S3.21, S3.22, S3.23, S3.24, S3.25] every machine 3 transition holds its guard and lands on its state', () => {
    const expected = Array.from({ length: 25 }, (_, i) => `S3.${String(i + 1).padStart(2, '0')}`)
    expect(TABLE.map((row) => row.id)).toEqual(expected)
    for (const row of TABLE) {
      const result = row.run()
      expect(result.transition, row.id).toBe(row.id)
      expect(result.mine?.state ?? null, row.id).toBe(row.state)
      row.check?.(result.mine)
    }
  })

  it('[S3.08, S3.09, S3.10, S3.15, S3.16] an input outside its source states is no transition', () => {
    const cases: ReadonlyArray<[MineState, MineInput]> = [
      ['active', { type: 'measurement-due' }],
      [
        'unrecorded',
        { type: 'measured', sourceWeight: { bytes: 1 }, thresholds: DEFAULT_TIER_THRESHOLDS }
      ],
      [
        'removed',
        { type: 'measured', sourceWeight: { bytes: 1 }, thresholds: DEFAULT_TIER_THRESHOLDS }
      ],
      ['measuring', { type: 'remeasure-requested' }],
      ['measuring', { type: 'folder-checked', folder: 'missing', reason: 'folder-missing' }],
      ['unenterable', { type: 'folder-checked', folder: 'missing', reason: 'folder-missing' }],
      ['active', { type: 'folder-checked', folder: 'present' }],
      ['removed', { type: 'removal-requested' }],
      ['removed', { type: 'removal-settled', everyDwarfEnded: true }],
      ['active', { type: 'host-booted' }]
    ]
    for (const [state, input] of cases) {
      const mine = mineIn(state)
      expect(transition(mine, input, LATER), `${state} ${input.type}`).toEqual({
        mine,
        transition: null
      })
    }
  })
})
