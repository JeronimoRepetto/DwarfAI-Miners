import { describe, expect, it } from 'vitest'
import {
  MINE_UNENTERABLE_REASON,
  crewPills,
  dwarfNeedsYou,
  mineCardLabel,
  mineCardMenu,
  mineCardView,
  mineRefusalToast
} from './mineCard'
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

  // APPENDED for #635 (PANEL-QUESTIONS 8, design lead ruling 2026-09-27): "1 needs you", and
  // "{n} need you" for any other count, as the nav badge's accessible name already reads.
  it('says "need you" for more than one dwarf waiting on you', () => {
    const asking = dwarf({ status: 'waiting', waitingReason: 'approval' })
    expect(crewPills([asking, asking])).toEqual([{ text: '2 need you', tone: 'needs', ask: true }])
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

  /*
   * AMENDED for #635 (PANEL-QUESTIONS 5, design lead ruling 2026-09-27; was: "..., which cannot be
   * entered", expecting `enterable` false). A remembered mine with no dwarf and no live session is
   * the ordinary card: it reads "No dwarfs" and opens, onto the empty roster and + Dwarf.
   */
  it('says No dwarfs for a remembered mine nobody is working, which still opens', () => {
    const view = mineCardView(row({ live: false }), [])
    expect(view.crew).toEqual([{ text: 'No dwarfs' }])
    expect(view.state).toBe('active')
    expect(view.enterable).toBe(true)
  })

  // APPENDED for #635 (PANEL-QUESTIONS 5 and 6): only a missing folder makes a card not enterable.
  it('refuses entry for a missing folder alone, live or not', () => {
    expect(mineCardView(row({ live: false, folderMissing: true }), []).enterable).toBe(false)
    expect(mineCardView(row({ folderMissing: true }), board([])).enterable).toBe(false)
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

/*
 * PANEL-QUESTIONS 6 (design lead ruling 2026-09-27): a mine is not enterable only when its folder
 * no longer exists, and the reason is "Folder not found. It was moved or deleted." — after the
 * "Not enterable" pill on its card, as the card button's title, and in the toast "<name>: <reason>".
 */
describe('mineCardView, a folder that no longer exists', () => {
  it('is not enterable, and says why', () => {
    const view = mineCardView(row({ live: false, folderMissing: true }), [])
    expect(view.state).toBe('unenterable')
    expect(view.enterable).toBe(false)
    expect(view.reason).toBe(MINE_UNENTERABLE_REASON)
    expect(MINE_UNENTERABLE_REASON).toBe('Folder not found. It was moved or deleted.')
    expect(view.progress).toBeUndefined()
  })

  it('names the toast "<name>: <reason>"', () => {
    expect(mineRefusalToast('old-shaft')).toBe(
      'old-shaft: Folder not found. It was moved or deleted.'
    )
  })

  it('leaves a mine whose folder is there as it was', () => {
    expect(mineCardView(row({}), []).state).toBe('active')
  })
})
