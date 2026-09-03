/**
 * What the world map's hover tooltip says, and where it goes (#136).
 *
 * Both are here rather than in the component for the reason the whole
 * `lib/`-`components/` split exists: the copy is three strings the design fixes
 * word for word, and the placement is arithmetic against a measured box. A
 * component that owned either would be the only place either could be checked.
 */
import { designTierLabel } from '../presentation'
import type { Mine } from '../../types'
import type { MapBoxSize, MapPoint } from './mapProjection'

/**
 * The design's tooltip box, to the pixel. Named here and used by the component,
 * so the placement maths and the CSS cannot drift apart.
 */
export const MAP_TOOLTIP_SIZE = { width: 170, height: 60 } as const

/** How long the pointer must rest on a marker before the tooltip appears. */
export const MAP_TOOLTIP_DELAY_MS = 300

/**
 * Distance between the marker and the tooltip's near corner. Not a design
 * value — the export shows a small gap and does not measure it — but the
 * tooltip must not sit on top of the 10px marker the user is pointing at.
 */
const TOOLTIP_GAP = 8

/** The three lines of the tooltip, exactly as the design words them. */
export interface MineTooltipCopy {
  /** `<Tier> - Mine`, with the design's own spelling of the tier. */
  tier: string
  /** The project or file name, as the board carries it. */
  name: string
  /** `Agents working: <count>`. */
  agents: string
}

/**
 * The tier here is `mine.tier` — the DRAWING tier, which is a provisional
 * bronze until the project's first walk finishes (#41). That is correct for a
 * label on a marker and would be wrong for anything that records a decision:
 * nothing in this file is written down, and the tooltip never reaches
 * `knownTier`.
 */
export function mineTooltipCopy(mine: Mine): MineTooltipCopy {
  return {
    tier: `${designTierLabel(mine.tier)} - Mine`,
    name: mine.name,
    agents: `Agents working: ${mine.dwarfs.length}`
  }
}

/** Where the tooltip's top-left corner goes, in pixels inside the map container. */
export interface MapTooltipPlacement {
  left: number
  top: number
}

/**
 * Place the tooltip above and to the right of a marker, then hold it inside the
 * container.
 *
 * Above-right is where the design's own export puts it. The clamp is a
 * decision: the design marks tooltip positioning near edges **Unspecified**,
 * because its map container is exactly the painting's ratio and its example
 * marker has room on every side. Ours is a resizable panel and a marker can sit
 * two pixels from a corner — and half a tooltip cut off by the panel edge is
 * the one outcome that loses information the user asked for. Moving it is not.
 */
export function placeMapTooltip(marker: MapPoint, box: MapBoxSize): MapTooltipPlacement {
  const left = marker.x + TOOLTIP_GAP
  const top = marker.y - TOOLTIP_GAP - MAP_TOOLTIP_SIZE.height
  return {
    left: hold(left, box.width, MAP_TOOLTIP_SIZE.width),
    top: hold(top, box.height, MAP_TOOLTIP_SIZE.height)
  }
}

/**
 * One axis, held between the container's two edges. A container smaller than
 * the tooltip pins it to the near edge rather than centring the overflow, so
 * the first line — the one that names the mine — is the part that survives.
 */
function hold(value: number, boxLength: number, tooltipLength: number): number {
  return Math.max(0, Math.min(value, boxLength - tooltipLength))
}
