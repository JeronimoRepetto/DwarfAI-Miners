import { describe, expect, it } from 'vitest'
import { MATERIAL_TOKENS_PER_UNIT } from '../types'
import { adaptSample, silenceMs } from './sample'

/*
 * The golden page reads the design's sample data at run time and adapts it to the app's own
 * contract types (#634); the data never enters this repository. What is pinned here is the
 * mapping alone, over small objects written for this test in the sample's shape, not copies of
 * the design's sample.
 */

function dm(data: Record<string, unknown>): unknown {
  return {
    data: {
      config: { shortcutFailed: false, guildEnabled: false },
      mines: [],
      dwarfs: [],
      ...data
    }
  }
}

const shaft = { id: 'north-shaft', name: 'North-Shaft', tier: 'copper', state: 'active', ore: {} }
const digger = {
  id: 'a1',
  name: 'digger-1',
  mine: 'north-shaft',
  role: 'worker',
  provider: 'Claude',
  model: 'm-large',
  effort: 'high',
  status: 'working',
  silence: '2m',
  worktree: 'feat/example'
}

describe('adaptSample', () => {
  it('reads the flags the panel shows from the config', () => {
    const sample = adaptSample(dm({ config: { shortcutFailed: true, guildEnabled: true } }))
    expect(sample.config).toEqual({ shortcutFailed: true, guildEnabled: true })
  })

  it('turns each mine into a Mine carrying its own dwarfs', () => {
    const other = { ...digger, id: 'b2', name: 'digger-2', mine: 'south-shaft' }
    const sample = adaptSample(
      dm({
        mines: [shaft, { ...shaft, id: 'south-shaft', name: 'South-Shaft' }],
        dwarfs: [digger, other]
      })
    )
    expect(sample.mines.map((m) => [m.id, m.name, m.tier, m.dwarfs.map((d) => d.id)])).toEqual([
      ['north-shaft', 'North-Shaft', 'copper', ['a1']],
      ['south-shaft', 'South-Shaft', 'copper', ['b2']]
    ])
  })

  it('stores ore as tokens per material, each through its own grain size and never summed', () => {
    const sample = adaptSample(dm({ mines: [{ ...shaft, ore: { coal: 4, silver: 2 } }] }))
    expect(sample.mines[0]?.materials).toEqual({
      coal: 4 * MATERIAL_TOKENS_PER_UNIT.coal,
      bronze: 0,
      copper: 0,
      silver: 2 * MATERIAL_TOKENS_PER_UNIT.silver,
      gold: 0,
      uranium: 0
    })
  })

  it('marks a mine that was never measured as unrecorded, and no other', () => {
    const sample = adaptSample(
      dm({
        mines: [
          { ...shaft, state: 'unrecorded' },
          { ...shaft, id: 'x', state: 'measuring' }
        ]
      })
    )
    expect(sample.mines.map((m) => m.unrecorded)).toEqual([true, undefined])
  })

  it('maps a dwarf onto the wire shape: provider id, role, model, silence and branch', () => {
    const [d] = adaptSample(dm({ mines: [shaft], dwarfs: [digger] })).mines[0]?.dwarfs ?? []
    expect(d).toMatchObject({
      id: 'a1',
      sessionId: 'a1',
      name: 'digger-1',
      provider: 'claude',
      role: 'worker',
      model: 'm-large',
      effort: 'high',
      status: 'working',
      silentForMs: 120_000,
      workplace: { path: 'north-shaft', branch: 'feat/example' }
    })
    expect(d?.waitingReason).toBeUndefined()
  })

  it('reads asking as waiting on the user, a permission need as waiting on approval, asleep as resting', () => {
    const sample = adaptSample(
      dm({
        mines: [shaft],
        dwarfs: [
          { ...digger, id: 'q', status: 'asking' },
          { ...digger, id: 'p', status: 'asking', need: 'permission' },
          { ...digger, id: 's', status: 'asleep' }
        ]
      })
    )
    expect(sample.mines[0]?.dwarfs.map((d) => [d.id, d.status, d.waitingReason ?? null])).toEqual([
      ['q', 'waiting', 'user-input'],
      ['p', 'waiting', 'approval'],
      ['s', 'waiting', null]
    ])
  })

  it('fails naming the value when the sample holds one the app has no word for', () => {
    expect(() =>
      adaptSample(dm({ mines: [shaft], dwarfs: [{ ...digger, provider: 'Nobody' }] }))
    ).toThrow(/provider "Nobody"/)
    expect(() =>
      adaptSample(dm({ mines: [shaft], dwarfs: [{ ...digger, status: 'dancing' }] }))
    ).toThrow(/status "dancing"/)
    expect(() => adaptSample(dm({ mines: [{ ...shaft, tier: 'tin' }] }))).toThrow(/tier "tin"/)
    expect(() => adaptSample(dm({ mines: [{ ...shaft, ore: { tin: 1 } }] }))).toThrow(
      /material "tin"/
    )
    expect(() =>
      adaptSample(dm({ mines: [shaft], dwarfs: [{ ...digger, mine: 'gone' }] }))
    ).toThrow(/mine "gone"/)
  })

  it('fails when the sample script did not define its data', () => {
    expect(() => adaptSample({})).toThrow(/DM\.data/)
    expect(() => adaptSample(undefined)).toThrow(/DM\.data/)
  })
})

describe('silenceMs', () => {
  it('reads seconds, minutes and hours', () => {
    expect(silenceMs('12s')).toBe(12_000)
    expect(silenceMs('6m')).toBe(360_000)
    expect(silenceMs('2h')).toBe(7_200_000)
  })

  it('fails on anything else rather than guessing', () => {
    expect(() => silenceMs('soon')).toThrow(/silence "soon"/)
  })
})
