import { describe, expect, it } from 'vitest'
import { crewPills, dwarfNeedsYou, mineCardLabel, mineCardMenu, mineCardView } from './mineCard'
import type { BrowseRow, Dwarf, Mine } from '../../types'

const KB = 1024

const dwarf = (over: Partial<Dwarf>): Dwarf =>
  ({ id: 'd', sessionId: 'd', name: 'd', provider: 'claude', status: 'working', ...over }) as Dwarf

const row = (over: Partial<BrowseRow>): BrowseRow => ({
  id: 'm1',
  path: 'm1',
  name: 'alpha',
  declared: false,
  addedAt: 1,
  live: true,
  ...over
})

const board = (dwarfs: Dwarf[]): Mine[] => [
  { id: 'm1', path: 'm1', name: 'alpha', tier: 'bronze', dwarfs, tokensObserved: 0, updatedAt: 0 }
]

describe('dwarfNeedsYou', () => {
  it('is a dwarf that asked something or waits on a permission, nothing else', () => {
    expect(dwarfNeedsYou(dwarf({ pendingQuestion: {} as Dwarf['pendingQuestion'] }))).toBe(true)
    expect(dwarfNeedsYou(dwarf({ status: 'waiting', waitingReason: 'approval' }))).toBe(true)
    expect(dwarfNeedsYou(dwarf({ status: 'waiting' }))).toBe(false)
  })
})

describe('crewPills', () => {
  it('counts working, needs you and asleep, each only when there is one', () => {
    const crew = [
      dwarf({ status: 'working' }),
      dwarf({ status: 'working' }),
      dwarf({ status: 'waiting', waitingReason: 'approval' }),
      dwarf({ status: 'waiting' })
    ]
    expect(crewPills(crew)).toEqual([
      { text: '2 working' },
      { text: '1 needs you', tone: 'needs', ask: true },
      { text: '1 asleep' }
    ])
  })

  it('says No dwarfs for an empty crew', () => {
    expect(crewPills([])).toEqual([{ text: 'No dwarfs' }])
  })

  it('says idle, with no count, when nobody is working, asking or asleep', () => {
    expect(crewPills([dwarf({ status: 'leaving' })])).toEqual([{ text: 'idle' }])
  })
})

describe('mineCardView', () => {
  it('states a measured mine’s tier, its ore per material, and its way to the next tier', () => {
    const view = mineCardView(
      row({
        knownTier: 'silver',
        weightBytes: 1630 * KB,
        materials: { coal: 5000, bronze: 20_000, copper: 0, silver: 0, gold: 0, uranium: 0 }
      }),
      board([dwarf({})])
    )
    expect(view).toMatchObject({
      tier: 'silver',
      measured: true,
      state: 'active',
      needs: false,
      enterable: true
    })
    expect(view.ore).toEqual([
      { material: 'coal', units: 2 },
      { material: 'bronze', units: 2 }
    ])
    expect(view.progress).toEqual({ value: 1630, max: 12_000, nextTier: 'gold' })
  })

  it('shows the top tier as Max tier with its weight, and no bar', () => {
    const view = mineCardView(row({ knownTier: 'uranium', weightBytes: 200_000 * KB }), board([]))
    expect(view.progress).toEqual({ maxTier: true, value: 200_000 })
  })

  it('draws a declared mine nobody has measured as Bronze, measuring, and never as a fact', () => {
    const view = mineCardView(row({ declared: true }), board([]))
    expect(view).toMatchObject({
      tier: 'bronze',
      measured: false,
      state: 'measuring',
      progress: { measuring: true }
    })
  })

  it('draws a board mine the store has no row for as working, not recorded yet', () => {
    const view = mineCardView(row({ unrecorded: true }), board([dwarf({})]))
    expect(view).toMatchObject({ tier: 'bronze', state: 'unrecorded', ore: [] })
    expect(view.progress).toBeUndefined()
  })

  it('marks a mine whose crew waits on you', () => {
    const view = mineCardView(
      row({}),
      board([dwarf({ status: 'waiting', waitingReason: 'approval' })])
    )
    expect(view.needs).toBe(true)
  })

  it('claims no crew for a live mine the board has not caught up with yet', () => {
    expect(mineCardView(row({}), []).crew).toEqual([])
  })

  it('says No dwarfs for a remembered mine nobody is working, which cannot be entered', () => {
    const view = mineCardView(row({ live: false }), [])
    expect(view.crew).toEqual([{ text: 'No dwarfs' }])
    expect(view.enterable).toBe(false)
  })
})

describe('mineCardLabel', () => {
  it('names the card button by what it opens, and says when it cannot be entered', () => {
    const view = mineCardView(row({ knownTier: 'gold' }), board([]))
    expect(mineCardLabel(view)).toBe('Open alpha, Gold')
    expect(mineCardLabel({ ...view, state: 'unenterable' })).toBe('Open alpha, Gold, not enterable')
  })
})

describe('mineCardMenu', () => {
  it('holds the removal, which confirms, and nothing that does not act', () => {
    expect(mineCardMenu(mineCardView(row({}), board([])))).toEqual([
      { label: 'Remove mine…', danger: true }
    ])
  })

  it('cannot remove a mine the store holds no row for', () => {
    expect(mineCardMenu(mineCardView(row({ unrecorded: true }), board([])))).toEqual([
      { label: 'Remove mine…', danger: true, disabled: true }
    ])
  })
})
