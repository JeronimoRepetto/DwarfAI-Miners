/*
 * The Work front's compact list line (`DS/docs/components.md` organisms/mine-rows, `crewText`; `DS/docs/copy.md`):
 * the words under a mine's name; and, for the Valle visual parity (EPIC-20; `DS/prototype/organisms/mine-rows/mine-rows.js`
 * `SORTS`, `apply`, `refresh`), the list's search, its three orders and each line's "?" needs-you mark. Every line is
 * built once; a search or a sort only hides and reorders them.
 */
import type { MineId } from '@dwarfai/contracts'
import { foldForSearch } from '../browse/boardRows'
import { MINE_TIERS, type MineTier } from '../../types'

/** How many dwarfs a mine holds, or that it cannot be entered. */
export function mineRowCrew(count: number, enterable: boolean): string {
  if (!enterable) return 'not enterable'
  if (count === 0) return 'no dwarfs'
  return count === 1 ? '1 dwarf' : `${count} dwarfs`
}

/** The list's three orders, in the order the sort button cycles them; the first is the default. */
export type MineRowSort = 'needs' | 'tier' | 'name'
const MINE_ROW_SORTS: readonly { value: MineRowSort; label: string }[] = [
  { value: 'needs', label: 'Needs you first' },
  { value: 'tier', label: 'Tier, richest first' },
  { value: 'name', label: 'Name' }
]
export const MINE_ROW_SORT_DEFAULT: MineRowSort = 'needs'

/** What a line knows of its mine. */
export interface MineRowFacts {
  mineId: MineId
  name: string
  /** Its tier, or `null` while never measured. */
  tier: MineTier | null
  /** Whether it was ever measured: an unmeasured mine ranks after every measured one by tier. */
  measured: boolean
  /** How many dwarfs it holds. */
  crew: number
  enterable: boolean
  /** How many of its dwarfs wait on the person. */
  needs: number
}

/** What a search that hides every line says. */
export const MINE_ROWS_EMPTY = 'No mine matches.'

const sortLabel = (mode: MineRowSort): string =>
  MINE_ROW_SORTS.find((sort) => sort.value === mode)!.label

export function nextMineRowSort(mode: MineRowSort): MineRowSort {
  const at = MINE_ROW_SORTS.findIndex((sort) => sort.value === mode)
  return MINE_ROW_SORTS[(at + 1) % MINE_ROW_SORTS.length]!.value
}

/** The sort button's name: the order in force. */
export const mineRowSortTitle = (mode: MineRowSort): string => 'Sort: ' + sortLabel(mode)

/** The toast a change of order shows: "Sorted by <label>", the label lowercased. */
export const mineRowSortToast = (mode: MineRowSort): string =>
  'Sorted by ' + sortLabel(mode).toLowerCase()

const rank = (row: MineRowFacts): number =>
  row.measured && row.tier !== null ? MINE_TIERS.indexOf(row.tier) : -1

/**
 * The lines a search leaves, in the order in force: the most dwarfs waiting first, then the larger crew, then the name;
 * by tier, richest first, an unmeasured mine after every measured one, then the name (the Host's mine carries no score);
 * or by name as a person reads it. The search folds as the Mines page's does.
 */
export function shownMineRows(
  rows: readonly MineRowFacts[],
  query: string,
  mode: MineRowSort
): MineRowFacts[] {
  const term = foldForSearch(query.trim())
  const shown = rows.filter((row) => term === '' || foldForSearch(row.name).includes(term))
  const byName = (a: MineRowFacts, b: MineRowFacts): number => a.name.localeCompare(b.name)
  if (mode === 'name') return shown.sort(byName)
  if (mode === 'needs')
    return shown.sort((a, b) => b.needs - a.needs || b.crew - a.crew || byName(a, b))
  return shown.sort((a, b) => rank(b) - rank(a) || byName(a, b))
}

/** A line's needs-you mark: "?" while one waits, with the count past one. */
export const mineRowAsk = (count: number): string =>
  count === 0 ? '' : '?' + (count > 1 ? String(count) : '')

/** A line's accessible name: the mine, its crew line and how many wait on the person. */
export function mineRowLabel(row: MineRowFacts): string {
  const waiting =
    row.needs === 0 ? '' : ', ' + row.needs + (row.needs === 1 ? ' needs you' : ' need you')
  return row.name + ', ' + mineRowCrew(row.crew, row.enterable) + waiting
}
