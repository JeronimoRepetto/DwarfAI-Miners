import { describe, expect, it } from 'vitest'
import { mineRowCrew } from './mineRows'

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
