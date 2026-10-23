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
import { filterCards, sortCards } from './minesList'
import type { BrowseRow, Dwarf, Mine } from '../../types'

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

const board = (dwarfs: Dwarf[], over: Partial<Mine> = {}): Mine[] => [
  {
    id: 'm1',
    path: 'm1',
    name: 'alpha',
    tier: 'bronze',
    dwarfs,
    tokensObserved: 0,
    updatedAt: 0,
    ...over
  }
]

/*
 * AMENDED for AMENDMENT-26 (owner-approved 2026-10-23; was: the weight, the ore and "declared, no weight yet" read off
 * the list row's `weightBytes`, `materials` and `declared`). The Host's list row (`mines.list`, 14 B-M19) carries the
 * tier only; the board's `MineWire` carries the ore (`totals`), the score (`score`) and whether the mine is being
 * measured (`state`), so these cases put them on the board mine. Every expectation is the one it was.
 */

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

  // VQA-04: the Host's own status rides on the board dwarf (hostStatus); today's `status` folds asking,
  // idle and asleep into one `waiting`, so the pills read the same word the scene draws.
  it('[VQA-04] counts an asking Host dwarf as needing you, not asleep', () => {
    const asking = dwarf({ status: 'waiting', hostStatus: 'asking' } as Partial<Dwarf>)
    expect(crewPills([asking])).toEqual([{ text: '1 needs you', tone: 'needs', ask: true }])
  })

  it('[VQA-04] counts an idle Host dwarf as idle, not asleep, and an asleep one as asleep', () => {
    const idle = dwarf({ status: 'waiting', hostStatus: 'idle' } as Partial<Dwarf>)
    const asleep = dwarf({ status: 'waiting', hostStatus: 'asleep' } as Partial<Dwarf>)
    expect(crewPills([idle])).toEqual([{ text: 'idle' }])
    expect(crewPills([idle, asleep])).toEqual([{ text: '1 asleep' }])
  })

  it('[VQA-04] marks the card as needing you for a Host ask, and counts it', () => {
    const asking = dwarf({ status: 'waiting', hostStatus: 'asking' } as Partial<Dwarf>)
    const view = mineCardView(row({}), board([asking, dwarf({ status: 'working' })]))
    expect(view).toMatchObject({ needs: true, needsCount: 1 })
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
      row({ knownTier: 'silver' }),
      board([dwarf({})], {
        tier: 'silver',
        score: { kb: 1630, nextTierKb: 12_000 },
        materials: { coal: 5000, bronze: 20_000, copper: 0, silver: 0, gold: 0, uranium: 0 }
      })
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
    const view = mineCardView(
      row({ knownTier: 'uranium' }),
      board([], { tier: 'uranium', score: { kb: 200_000, nextTierKb: null } })
    )
    expect(view.progress).toEqual({ maxTier: true, value: 200_000 })
  })

  it('draws a declared mine nobody has measured as Bronze, measuring, and never as a fact', () => {
    const view = mineCardView(row({ declared: true }), board([], { measuring: true }))
    expect(view).toMatchObject({
      tier: 'bronze',
      measured: false,
      state: 'measuring',
      progress: { measuring: true }
    })
  })

  // APPENDED for #635 (PANEL-QUESTIONS 29, design lead ruling 2026-09-27): a mine measured before
  // keeps its last tier while it is re-measured. The store's tier with no weight yet is a reading
  // from an earlier run and a walk this run still owes it; a stale reading still counts as known
  // (#41), so the card keeps that tier, answers its tier filter and keeps its place.
  it('keeps a re-measured mine’s last tier while it shows Measuring…', () => {
    const view = mineCardView(
      row({ declared: true, knownTier: 'copper' }),
      board([], { tier: 'copper', measuring: true })
    )
    expect(view).toMatchObject({
      tier: 'copper',
      measured: true,
      state: 'measuring',
      progress: { measuring: true }
    })
  })

  it('ranks a re-measured mine in its tier and a never-measured one last', () => {
    const onBoard = (id: string, over: Partial<Mine>): Mine[] =>
      board([], { id, path: id, name: id, ...over })
    const cards = [
      mineCardView(
        row({ id: 'new', name: 'new', declared: true }),
        onBoard('new', { measuring: true })
      ),
      mineCardView(
        row({ id: 'low', name: 'low', knownTier: 'bronze' }),
        onBoard('low', { score: { kb: 1, nextTierKb: 350 } })
      ),
      mineCardView(
        row({ id: 'again', name: 'again', declared: true, knownTier: 'copper' }),
        onBoard('again', { tier: 'copper', measuring: true })
      )
    ]
    expect(sortCards(cards, 'tier').map((card) => [card.name, card.state])).toEqual([
      ['again', 'measuring'],
      ['low', 'active'],
      ['new', 'measuring']
    ])
    expect(filterCards(cards, '', 'copper').map((card) => card.name)).toEqual(['again'])
    expect(filterCards(cards, '', 'bronze').map((card) => card.name)).toEqual(['low'])
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
