import { describe, expect, it } from 'vitest'
import {
  MINE_ROW_SORT_DEFAULT,
  MINE_ROWS_EMPTY,
  mineRowAsk,
  mineRowCrew,
  mineRowLabel,
  mineRowSortTitle,
  mineRowSortToast,
  nextMineRowSort,
  shownMineRows,
  type MineRowFacts
} from './mineRows'

/*
 * The Work front's compact list line (`DS/docs/components.md` organisms/mine-rows; `DS/docs/copy.md`): under each
 * mine's name, how many dwarfs it holds, or that it cannot be entered.
 */
describe("a line of the Work front's mines list", () => {
  it('reads its crew as "1 dwarf", "N dwarfs" or "no dwarfs", and "not enterable" for a mine that cannot be entered', () => {
    expect(mineRowCrew(1, true)).toBe('1 dwarf')
    expect(mineRowCrew(4, true)).toBe('4 dwarfs')
    expect(mineRowCrew(0, true)).toBe('no dwarfs')
    expect(mineRowCrew(3, false)).toBe('not enterable')
  })
})

/*
 * APPENDED for the Valle visual parity (EPIC-20): the list's search, its three orders and each line's "?" needs-you
 * mark (`DS/prototype/organisms/mine-rows/mine-rows.js` `SORTS`, `apply`, `refresh`; `DS/docs/copy.md` organisms/mine-rows).
 */
describe("the Work front's mines list: search, sort and the needs-you mark", () => {
  const row = (name: string, over: Partial<MineRowFacts> = {}): MineRowFacts => ({
    mineId: name as MineRowFacts['mineId'],
    name,
    tier: 'bronze',
    measured: true,
    crew: 1,
    enterable: true,
    needs: 0,
    ...over
  })
  const rows = [
    row('ore-ledger', { tier: 'copper', crew: 1 }),
    row('AI-Tools', { tier: 'gold', crew: 3, needs: 1 }),
    row('DwarfAI-Miners', { tier: 'silver', crew: 4, needs: 1 }),
    row('old-shaft', { crew: 0, enterable: false, measured: false }),
    row('deep-vault', { tier: 'uranium', crew: 1 })
  ]
  const names = (shown: readonly MineRowFacts[]) => shown.map((r) => r.name)

  it('[US-MINES-003.AC07] the orders cycle from Needs you first to Tier, richest first and Name, each named on the button and in its toast', () => {
    expect(MINE_ROW_SORT_DEFAULT).toBe('needs')
    expect(mineRowSortTitle('needs')).toBe('Sort: Needs you first')
    expect(nextMineRowSort('needs')).toBe('tier')
    expect(nextMineRowSort('tier')).toBe('name')
    expect(nextMineRowSort('name')).toBe('needs')
    expect(mineRowSortToast('tier')).toBe('Sorted by tier, richest first')
  })

  it('[US-MINES-003.AC03] needs-you first breaks ties by the larger crew, then the name; tier ranks the unmeasured last; name reads A to Z', () => {
    expect(names(shownMineRows(rows, '', 'needs'))).toEqual([
      'DwarfAI-Miners',
      'AI-Tools',
      'deep-vault',
      'ore-ledger',
      'old-shaft'
    ])
    expect(names(shownMineRows(rows, '', 'tier'))).toEqual([
      'deep-vault',
      'AI-Tools',
      'DwarfAI-Miners',
      'ore-ledger',
      'old-shaft'
    ])
    expect(names(shownMineRows(rows, '', 'name'))).toEqual([
      'AI-Tools',
      'deep-vault',
      'DwarfAI-Miners',
      'old-shaft',
      'ore-ledger'
    ])
  })

  it('[US-MINES-001.AC01] a search keeps the names that hold it, folded as the Mines page folds them', () => {
    expect(names(shownMineRows(rows, 'DWARF', 'needs'))).toEqual(['DwarfAI-Miners'])
    expect(names(shownMineRows(rows, '  ', 'name'))).toHaveLength(5)
    expect(shownMineRows(rows, 'nothing', 'needs')).toEqual([])
    expect(MINE_ROWS_EMPTY).toBe('No mine matches.')
  })

  it('[US-VALLE-004.AC03] a line waiting on you carries "?" and its count past one, and says so in its name', () => {
    expect(mineRowAsk(0)).toBe('')
    expect(mineRowAsk(1)).toBe('?')
    expect(mineRowAsk(3)).toBe('?3')
    expect(mineRowLabel(row('DwarfAI-Miners', { crew: 4, needs: 1 }))).toBe(
      'DwarfAI-Miners, 4 dwarfs, 1 needs you'
    )
    expect(mineRowLabel(row('AI-Tools', { crew: 3, needs: 2 }))).toBe(
      'AI-Tools, 3 dwarfs, 2 need you'
    )
    expect(mineRowLabel(row('old-shaft', { crew: 0, enterable: false }))).toBe(
      'old-shaft, not enterable'
    )
  })
})
