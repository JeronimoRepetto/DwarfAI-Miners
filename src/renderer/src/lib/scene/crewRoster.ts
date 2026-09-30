/*
 * The crew roster (#635), `molecules/crew-roster` in the design: one portrait per dwarf of a mine,
 * each a stable place to find, press and read it while the sprites walk and overlap (screens/mine.md,
 * W3·4). Five fit; with six or more the row shows the first four and a +N menu of the rest, and it
 * never scrolls. The component draws; this decides who is shown and what the menu says.
 */
import { sceneDwarfStatus } from './sceneDwarf'
import { dwarfDisplayName } from '../dwarf/displayName'
import type { MenuItem } from '../overlay/menu'
import type { Dwarf } from '../../types'

/** How many portraits fit in the row (crewRoster's `max`, default 5). */
export const ROSTER_MAX = 5

export const ROSTER_EMPTY = 'No dwarfs here yet.'

export function rosterMoreLabel(count: number): string {
  return count + ' more dwarfs'
}

/** The portraits drawn and the dwarfs left to +N; +N itself takes the last place. */
export function rosterSplit<T>(
  dwarfs: readonly T[],
  max: number = ROSTER_MAX
): { shown: T[]; rest: T[] } {
  if (dwarfs.length <= max) return { shown: [...dwarfs], rest: [] }
  const room = Math.max(0, max - 1)
  return { shown: dwarfs.slice(0, room), rest: dwarfs.slice(room) }
}

/*
 * The +N menu (screens/mine.md, As built): one item per remaining dwarf, labelled with the name
 * the app calls it by (its custom name when it has one, #635),
 * hinted "?" while it is asking, else its raw status word.
 */
export function rosterMenuItems(rest: readonly Dwarf[]): MenuItem[] {
  return rest.map((dwarf) => {
    const status = sceneDwarfStatus(dwarf)
    return { label: dwarfDisplayName(dwarf), hint: status === 'asking' ? '?' : status }
  })
}
