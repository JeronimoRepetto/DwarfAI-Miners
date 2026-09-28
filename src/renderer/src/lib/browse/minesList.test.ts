import { describe, expect, it } from 'vitest'
import {
  SORT_MODES,
  countText,
  emptyState,
  filterCards,
  nextSort,
  removedToast,
  removeTitle,
  sortCards,
  sortLabel,
  sortToast,
  REMOVE_BODY
} from './minesList'
import type { MineCardView } from './mineCard'

const card = (over: Partial<MineCardView>): MineCardView => ({
  id: over.name ?? 'x',
  name: 'x',
  tier: 'bronze',
  measured: true,
  state: 'active',
  ore: [],
  crew: [],
  needs: false,
  needsCount: 0,
  enterable: true,
  removable: true,
  ...over
})

const valley = [
  card({ name: 'ore-ledger', tier: 'copper', score: 212 }),
  card({ name: 'Deep-Vault', tier: 'uranium', score: 9412 }),
  card({ name: 'alpha', tier: 'silver', score: 740, needsCount: 2, needs: true }),
  card({ name: 'beta', tier: 'silver', score: 1630, needsCount: 1, needs: true }),
  card({ name: 'fresh', tier: 'bronze', measured: false })
]
const names = (cards: MineCardView[]) => cards.map((c) => c.name)

describe('sort orders', () => {
  it('cycles tier, then name, then needs you first, and back', () => {
    expect(SORT_MODES.map((m) => m.value)).toEqual(['tier', 'name', 'needs'])
    expect(nextSort('tier')).toBe('name')
    expect(nextSort('name')).toBe('needs')
    expect(nextSort('needs')).toBe('tier')
  })

  it('names each order as the sort button and the toast say it', () => {
    expect(sortLabel('tier')).toBe('Tier, richest first')
    expect(sortToast('needs')).toBe('Sorted by needs you first')
    expect(sortToast('name')).toBe('Sorted by name')
  })

  it('puts the richest tier first, then the higher score, and an unmeasured mine last', () => {
    expect(names(sortCards(valley, 'tier'))).toEqual([
      'Deep-Vault',
      'beta',
      'alpha',
      'ore-ledger',
      'fresh'
    ])
  })

  it('puts the mines that wait on you most first, then by score, not by tier', () => {
    expect(names(sortCards(valley, 'needs')).slice(0, 2)).toEqual(['alpha', 'beta'])
  })

  it('orders by name as a person reads it', () => {
    expect(names(sortCards(valley, 'name'))).toEqual([
      'alpha',
      'beta',
      'Deep-Vault',
      'fresh',
      'ore-ledger'
    ])
  })
})

describe('filterCards', () => {
  it('keeps the names holding what was typed, folded like the store folds them', () => {
    const cards = [card({ name: 'Cafetería' }), card({ name: 'alpha' })]
    expect(names(filterCards(cards, 'CAFETERIA', null))).toEqual(['Cafetería'])
  })

  it('keeps the mines of the chosen tier, and never one whose tier is only a placeholder', () => {
    expect(names(filterCards(valley, '', 'bronze'))).toEqual([])
    expect(names(filterCards(valley, '', 'silver'))).toEqual(['alpha', 'beta'])
  })
})

describe('emptyState', () => {
  it('shows nothing while a card is shown', () => {
    expect(emptyState({ query: '', tier: null, shown: 1, total: 1 })).toBeUndefined()
  })

  it('says No mines yet over the primary Add a mine on a first run', () => {
    expect(emptyState({ query: '', tier: null, shown: 0, total: 0 })).toEqual({
      title: 'No mine found',
      text: 'No mines yet.',
      action: 'add'
    })
  })

  it('names what was searched for, and in which tier, over Clear search', () => {
    expect(emptyState({ query: 'zz', tier: 'gold', shown: 0, total: 3 })).toEqual({
      title: 'No mine found',
      text: 'Nothing matches “zz” in Gold.',
      action: 'clear'
    })
    expect(emptyState({ query: 'zz', tier: null, shown: 0, total: 0 })!.action).toBe('clear')
  })

  it('says a tier has no mine yet, with no button: the All chip is right above', () => {
    expect(emptyState({ query: '', tier: 'copper', shown: 0, total: 3 })).toEqual({
      title: 'No mine found',
      text: 'No Copper mine yet.'
    })
  })
})

describe('the words around the list', () => {
  it('counts what is shown out of every mine', () => {
    expect(countText(2, 7)).toBe('2 of 7 mines')
  })

  it('asks before a removal and says it happened after', () => {
    expect(removeTitle('alpha')).toBe('Remove alpha?')
    expect(REMOVE_BODY).toBe(
      'The mine leaves the valley and its dwarfs are sent home. The project folder and its ore stay on disk.'
    )
    expect(removedToast('alpha')).toBe('alpha removed')
  })
})
