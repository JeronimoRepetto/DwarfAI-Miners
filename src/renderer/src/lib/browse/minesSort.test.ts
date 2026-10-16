import { describe, expect, it } from 'vitest'
import { SORT_MODES, nextSort, sortCards, sortLabel, sortToast, type MineSort } from './minesList'
import type { MineCardView } from './mineCard'

/*
 * ISSUE-253: the Mines page's three orders (US-MINES-003). Tier, score, measured and the needs-you
 * count are the card's, built from the Host's read model (ADR-033 item 3); the sort only reads them.
 */

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
const names = (cards: MineCardView[]) => cards.map((c) => c.name)

describe('ISSUE-253 mines sort', () => {
  it('[US-MINES-003.AC01, US-MINES-003.AC02, US-MINES-003.AC06] the sort icon cycles Tier richest first, Name and Needs you first, wraps, and every change raises its toast', () => {
    expect(SORT_MODES[0]!.value).toBe('tier')
    const seen: MineSort[] = []
    let mode: MineSort = 'tier'
    for (let click = 0; click < 3; click++) {
      mode = nextSort(mode)
      seen.push(mode)
    }
    expect(seen).toEqual(['name', 'needs', 'tier'])
    expect(seen.map(sortLabel)).toEqual(['Name', 'Needs you first', 'Tier, richest first'])
    /*
     * Every change has its toast, the wrap back to the tier order included. The words are the
     * design's (organisms/page-header and mines-list at d12d3fc: "Sorted by " + the label
     * lowercased); the story's US-MINES-003.AC06 reads "Sorted by tier" for the wrap. Recorded as
     * a design-over-story difference in the ISSUE-253 hand-off; the toast is raised by App.vue.
     */
    expect(seen.map(sortToast)).toEqual([
      'Sorted by name',
      'Sorted by needs you first',
      'Sorted by tier, richest first'
    ])
  })

  it('[US-MINES-003.AC03, US-MINES-003.AC05] tier order breaks ties by score, unmeasured mines rank last and a re-measured mine keeps its place', () => {
    const cards = [
      card({ name: 'fresh', tier: 'bronze', measured: false, state: 'measuring' }),
      card({ name: 'low-gold', tier: 'gold', score: 2100 }),
      card({ name: 'copper', tier: 'copper', score: 300 }),
      card({ name: 'high-gold', tier: 'gold', score: 3900 }),
      // Re-measured: its last tier and score are kept while it measures again.
      card({ name: 'again', tier: 'gold', score: 3000, state: 'measuring' }),
      card({ name: 'bronze', tier: 'bronze', score: 10 })
    ]
    expect(names(sortCards(cards, 'tier'))).toEqual([
      'high-gold',
      'again',
      'low-gold',
      'copper',
      'bronze',
      'fresh'
    ])
  })

  it('[US-MINES-003.AC04] needs-you order breaks ties by score', () => {
    const cards = [
      card({ name: 'rich-quiet', tier: 'uranium', score: 9000, needsCount: 0 }),
      // A richer tier than rich-asks, but a lower score (as a re-measured mine can hold).
      card({ name: 'poor-asks', tier: 'gold', score: 200, needsCount: 1 }),
      card({ name: 'rich-asks', tier: 'silver', score: 900, needsCount: 1 }),
      card({ name: 'most', tier: 'bronze', score: 5, needsCount: 3 })
    ]
    // Within one count the higher score wins, not the richer tier.
    expect(names(sortCards(cards, 'needs'))).toEqual([
      'most',
      'rich-asks',
      'poor-asks',
      'rich-quiet'
    ])
  })
})
