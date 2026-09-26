/*
 * The redesigned Panel nav's groups and the one count it shows (#635), `organisms/nav` in the
 * design: the World group (Map, Mines), the Guild group (Lab, Market, Laboral Union) that ships
 * hidden behind the guild flag, and the System group (Settings, then the music toggle and the
 * mode lever, which are not areas). The component draws these; this decides them.
 */
import type { IconName } from '../icon/iconGrids'
import type { Mine, ShellArea } from '../../types'
import { unavailableAreaOf } from './shellNav'

export interface PanelNavSlot {
  area: ShellArea
  /** The design's slot id (`data-slot`), which is not always the area's own name. */
  id: string
  label: string
  icon: IconName
}

export const WORLD_SLOTS: readonly PanelNavSlot[] = [
  { area: 'map', id: 'map', label: 'Map', icon: 'map' },
  { area: 'mines', id: 'mines', label: 'Mines', icon: 'mines' }
]

export const GUILD_SLOTS: readonly PanelNavSlot[] = [
  { area: 'lab', id: 'lab', label: 'Lab', icon: 'lab' },
  { area: 'market', id: 'market', label: 'Market', icon: 'market' },
  { area: 'laboral-union', id: 'union', label: 'Laboral Union', icon: 'union' }
]

export const SYSTEM_SLOTS: readonly PanelNavSlot[] = [
  { area: 'settings', id: 'settings', label: 'Settings', icon: 'settings' }
]

/**
 * How many dwarfs need you, for the Mines slot's badge (screens/shell.md, W1·10: "Mines carries a
 * badge when any dwarf needs you").
 *
 * Needing you is a proven ask and nothing weaker: a structured question waiting for an answer, or
 * a permission dialog the session is holding open — the two facts the dwarf's own "?" marker is
 * drawn for. A dwarf merely resting, or blocked on something unnamed, has asked nobody anything,
 * and a badge that claimed otherwise would train the person to ignore it. Each dwarf counts once.
 */
export function needsYouCount(mines: readonly Mine[]): number {
  let count = 0
  for (const mine of mines)
    for (const dwarf of mine.dwarfs)
      if (dwarf.pendingQuestion !== undefined || dwarf.waitingReason === 'approval') count++
  return count
}

/**
 * The area the page may show, given whether the guild areas are shown.
 *
 * While the guild flag is off nothing may point at a guild area, so a view left on one — there is
 * no control that reaches it, but a view is state and state outlives its entry points — shows the
 * map, the default page, rather than an area the person cannot see in the nav.
 */
export function reachableArea(area: ShellArea, guildAreasEnabled: boolean): ShellArea {
  if (guildAreasEnabled || unavailableAreaOf(area) === undefined) return area
  return 'map'
}
