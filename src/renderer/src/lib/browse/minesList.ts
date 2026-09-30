/*
 * What the Mines page decides (#635), `organisms/mines-list` in the design: which cards a search
 * and a tier chip leave shown, the three orders the sort button cycles through, the empty state's
 * words and its one button, and the lines around a removal (screens/browse.md, As built).
 *
 * Every card is built once; a filter or a sort only hides and reorders them. A tier chip answers
 * with measured tiers only: a mine nobody has measured wears the Bronze placeholder, which is for
 * drawing and never matches the Bronze chip (#41). The component draws; this decides.
 */
import { foldForSearch } from './boardRows'
import { designTierLabel } from '../presentation'
import { MINE_TIERS } from '../../types'
import type { MineTier } from '../../types'
import type { MineCardView } from './mineCard'

export type MineSort = 'tier' | 'name' | 'needs'

/** The orders in the order the sort button cycles them. */
export const SORT_MODES: readonly { value: MineSort; label: string }[] = [
  { value: 'tier', label: 'Tier, richest first' },
  { value: 'name', label: 'Name' },
  { value: 'needs', label: 'Needs you first' }
]

export const sortLabel = (mode: MineSort): string => SORT_MODES.find((m) => m.value === mode)!.label

export function nextSort(mode: MineSort): MineSort {
  const at = SORT_MODES.findIndex((m) => m.value === mode)
  return SORT_MODES[(at + 1) % SORT_MODES.length]!.value
}

/** The toast a change of order shows: "Sorted by <label>", the label lowercased. */
export const sortToast = (mode: MineSort): string => 'Sorted by ' + sortLabel(mode).toLowerCase()

// A measured tier's rank, richest highest; an unmeasured mine ranks below every tier.
const rank = (card: MineCardView): number => (card.measured ? MINE_TIERS.indexOf(card.tier) : -1)
const score = (card: MineCardView): number => card.score ?? -1

/**
 * The order in force: by tier, richest first, then by score; by how many of the crew wait on you,
 * then by score (not by tier); or by name as a person reads it.
 */
export function sortCards(cards: readonly MineCardView[], mode: MineSort): MineCardView[] {
  const sorted = [...cards]
  if (mode === 'name') return sorted.sort((a, b) => a.name.localeCompare(b.name))
  if (mode === 'needs') {
    return sorted.sort((a, b) => b.needsCount - a.needsCount || score(b) - score(a))
  }
  return sorted.sort((a, b) => rank(b) - rank(a) || score(b) - score(a))
}

/** The cards a search and a tier chip leave shown, folded the way the store folds names. */
export function filterCards(
  cards: readonly MineCardView[],
  query: string,
  tier: MineTier | null
): MineCardView[] {
  const term = foldForSearch(query)
  return cards.filter(
    (card) =>
      (term === '' || foldForSearch(card.name).includes(term)) &&
      (tier === null || (card.measured && card.tier === tier))
  )
}

export interface EmptyState {
  title: string
  text: string
  /** The empty state's one button: Clear search, or the primary Add a mine. */
  action?: 'clear' | 'add'
}

/**
 * The empty state, when nothing is shown: "No mine found" over one line. A search names what was
 * typed (and the tier, when a chip is on) over Clear search; no mines at all reads "No mines
 * yet." over the primary Add a mine; a tier chip alone gets no button, the All chip being right
 * above it (decision log, First run: add a mine).
 */
export function emptyState(o: {
  query: string
  tier: MineTier | null
  shown: number
  total: number
}): EmptyState | undefined {
  if (o.shown > 0) return undefined
  const title = 'No mine found'
  if (o.query !== '') {
    const where = o.tier === null ? '' : ' in ' + designTierLabel(o.tier)
    return { title, text: 'Nothing matches “' + o.query + '”' + where + '.', action: 'clear' }
  }
  if (o.total === 0) return { title, text: 'No mines yet.', action: 'add' }
  return { title, text: 'No ' + designTierLabel(o.tier ?? MINE_TIERS[0]!) + ' mine yet.' }
}

export const countText = (shown: number, total: number): string => shown + ' of ' + total + ' mines'

export const removeTitle = (name: string): string => 'Remove ' + name + '?'

export const REMOVE_BODY =
  'The mine leaves the valley and its dwarfs are sent home. The project folder and its ore stay on disk.'

export const removedToast = (name: string): string => name + ' removed'
