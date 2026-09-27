/*
 * The redesigned mine column (#635), `organisms/mine-column` in the design: one open mine, its
 * toolbar plate, the clean art with the crew on real work points, the roster and the footer. This
 * decides who is drawn where; the component draws.
 *
 * The art box carries the painting's own aspect (`.dm-minecol__art`, 1184 / 3622), so a station's
 * image percent is its box percent and a dwarf is placed with it as it is: nothing is projected,
 * fitted or clamped (components.md, Dwarf in the scene: "stations are image percent"; the
 * coordinates rule).
 *
 * THE WALK IS RETIRED (#635). The design's Panel dwarf stands at its station: a new one fades in
 * there (`.dm-dwarf.is-entering`), status changes swap its sheet in place, and motion animates only
 * transform and opacity, never a position. So nobody walks the interior's routes any more, and a
 * dwarf on its way out keeps the station it had rather than jumping to a spawn point.
 */
import { assignScene, type SceneOccupant } from './sceneAssignment'
import { sceneLayout } from './sceneLayout'
import type { Dwarf, Mine, MineTier } from '../../types'

export const ADD_DWARF_LABEL = '+ Dwarf'

/** The footer strip keeps this many of the richest materials (the design's mine column passes 4). */
export const MINE_FOOTER_ORE_MAX = 4

export function mineColumnLabel(name: string): string {
  return 'Mine ' + name
}

export function interiorLabel(name: string): string {
  return name + ' interior'
}

/*
 * One entry per dwarf id (#165): the board is assembled from several sources plus a held session's
 * own crew, and two of them naming one session put it in the list twice — two sprites, two halos
 * for one selection. The first listing wins, so a dwarf does not change with whichever source
 * spoke last. Everything the column does per dwarf reads this rather than the raw list.
 */
export function mineCrew(mine: Pick<Mine, 'dwarfs'>): Dwarf[] {
  const seen = new Set<string>()
  return mine.dwarfs.filter((dwarf) => {
    if (seen.has(dwarf.id)) return false
    seen.add(dwarf.id)
    return true
  })
}

/** Where a dwarf stands, in percent of the painting, and whether it faces as painted (left). */
export interface Station {
  x: number
  y: number
  facesLeft: boolean
}

export interface DwarfStand extends Station {
  dwarf: Dwarf
}

/*
 * A leaving dwarf is placed as the worker or foreman it was, so it keeps its station, and so the
 * pools the rest of the crew are hashed into are the ones they already had.
 */
function occupantOf(dwarf: Dwarf): SceneOccupant {
  return {
    id: dwarf.id,
    role: dwarf.role,
    status: dwarf.status === 'leaving' ? 'working' : dwarf.status
  }
}

/**
 * Every dwarf on its station, in the crew's own order: the design draws the crew as the board
 * lists it, every dwarf at the one z-index (anatomy.md, Mine column; components.md, Dwarf), and
 * the board's order is already stable across polls (mineCrew). `stations` names a station per
 * dwarf where the caller decides it (the design's own sample does); every other dwarf takes the one
 * the scene assigns deterministically from its id.
 */
export function mineStands(
  crew: readonly Dwarf[],
  tier: MineTier,
  stations: Readonly<Record<string, Station>> = {}
): DwarfStand[] {
  const placements = assignScene(crew.map(occupantOf), sceneLayout(tier))
  const stands: DwarfStand[] = []
  for (const dwarf of crew) {
    const named = stations[dwarf.id]
    const placed = placements.get(dwarf.id)
    const at: Station | undefined =
      named ?? (placed && { x: placed.point.x, y: placed.point.y, facesLeft: placed.facesLeft })
    if (!at) continue
    stands.push({ dwarf, ...at })
  }
  return stands
}
