/*
 * The Work front's compact list line (`DS/docs/components.md` organisms/mine-rows, `crewText`; `DS/docs/copy.md`):
 * the words under a mine's name.
 */

/** How many dwarfs a mine holds, or that it cannot be entered. */
export function mineRowCrew(count: number, enterable: boolean): string {
  if (!enterable) return 'not enterable'
  if (count === 0) return 'no dwarfs'
  return count === 1 ? '1 dwarf' : `${count} dwarfs`
}
