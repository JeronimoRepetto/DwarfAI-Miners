import { describe, expect, it } from 'vitest'
import { filterCards } from './minesList'
import { mineCardView, type MineCardView } from './mineCard'
import type { BrowseRow, Mine } from '../../types'

/*
 * ISSUE-253: the Mines page's search and tier filter (US-MINES-001, US-MINES-002), over cards built
 * from the Host's browse rows by mineCardView. Whether a tier was measured comes from the row
 * (ADR-033 item 3); the filter only reads it. The helper is `filterCards` in minesList.ts.
 */

const row = (over: Partial<BrowseRow>): BrowseRow => ({
  id: over.name ?? 'x',
  path: over.name ?? 'x',
  name: 'x',
  declared: true,
  addedAt: 1,
  live: false,
  ...over
})

const KB = 1024
const cardsOf = (rows: Partial<BrowseRow>[]): MineCardView[] =>
  rows.map((over) => mineCardView(row(over), []))
const names = (cards: MineCardView[]) => cards.map((c) => c.name)

const valley = cardsOf([
  { name: 'Cafetería', knownTier: 'gold', weightBytes: 3000 * KB },
  { name: 'cafe-tools', knownTier: 'copper', weightBytes: 200 * KB },
  { name: 'ore-ledger', knownTier: 'gold', weightBytes: 2500 * KB },
  { name: 'Deep-Vault', knownTier: 'uranium', weightBytes: 9000 * KB }
])

describe('ISSUE-253 mines filter', () => {
  it('[US-MINES-001.AC01, US-MINES-001.AC05, NFR-PERF-05] the list filters on every keystroke in memory, ignoring case and accents', () => {
    // Every prefix a person types is its own synchronous call: no submit, no await.
    const typed = ['C', 'CA', 'CAF', 'CAFÉ', 'CAFET']
    const shown = typed.map((query) => names(filterCards(valley, query, null)))
    expect(shown).toEqual([
      ['Cafetería', 'cafe-tools'],
      ['Cafetería', 'cafe-tools'],
      ['Cafetería', 'cafe-tools'],
      ['Cafetería', 'cafe-tools'],
      ['Cafetería']
    ])
    expect(names(filterCards(valley, 'cafeteria', null))).toEqual(['Cafetería'])
    expect(names(filterCards(valley, 'DEEP', null))).toEqual(['Deep-Vault'])
    // NFR-PERF-05: the answer is a plain array, not a promise.
    expect(Array.isArray(filterCards(valley, 'c', null))).toBe(true)
  })

  it('[US-MINES-001.AC04, US-MINES-002.AC03] the search and the tier filter always apply together', () => {
    expect(names(filterCards(valley, 'caf', 'gold'))).toEqual(['Cafetería'])
    // Changing either one keeps the other.
    expect(names(filterCards(valley, 'caf', 'copper'))).toEqual(['cafe-tools'])
    expect(names(filterCards(valley, 'ore', 'gold'))).toEqual(['ore-ledger'])
    expect(names(filterCards(valley, '', 'gold'))).toEqual(['Cafetería', 'ore-ledger'])
  })

  it('[US-MINES-002.AC01, US-MINES-002.AC05] a tier chip keeps only its tier and a second chip replaces the first', () => {
    expect(names(filterCards(valley, '', 'gold'))).toEqual(['Cafetería', 'ore-ledger'])
    // Single-select: the filter holds one tier, so after Uranium no Gold mine is left. The chips
    // asking for the new tier in place of the old one: MinesList.test.ts, same ids.
    expect(names(filterCards(valley, '', 'uranium'))).toEqual(['Deep-Vault'])
  })

  it('[US-MINES-002.AC02] All shows every mine that the search allows', () => {
    expect(names(filterCards(valley, '', null))).toEqual(names(valley))
    expect(names(filterCards(valley, 'caf', null))).toEqual(['Cafetería', 'cafe-tools'])
  })

  it('[US-MINES-002.AC06, US-MINES-002.AC07] an unmeasured mine appears only under All with the Bronze placeholder and a re-measured mine keeps answering its last known tier', () => {
    // AMENDED for AMENDMENT-26 (owner-approved 2026-10-23; was: a declared row with no weight read as measuring):
    // measuring is the Host's `MineWire.state`, which the board carries; the list row no longer says it.
    const measuring = (id: string, tier: Mine['tier']): Mine[] => [
      { id, path: id, name: id, tier, dwarfs: [], tokensObserved: 0, updatedAt: 0, measuring: true }
    ]
    const fresh = mineCardView(row({ name: 'fresh' }), measuring('fresh', 'bronze'))
    const again = mineCardView(
      row({ name: 'again', knownTier: 'silver' }), // measured before, measured again now
      measuring('again', 'silver')
    )
    expect(fresh).toMatchObject({ tier: 'bronze', measured: false, state: 'measuring' })
    expect(again).toMatchObject({ tier: 'silver', measured: true, state: 'measuring' })
    const cards = [...valley, fresh, again]
    for (const tier of ['bronze', 'copper', 'silver', 'gold', 'uranium'] as const) {
      expect(names(filterCards(cards, '', tier))).not.toContain('fresh')
    }
    expect(names(filterCards(cards, '', null))).toContain('fresh')
    expect(names(filterCards(cards, '', 'silver'))).toEqual(['again'])
  })
})
