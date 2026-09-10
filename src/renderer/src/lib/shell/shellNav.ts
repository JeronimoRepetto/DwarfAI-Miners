/**
 * The shell's navigation stack, and which way its arrow points (#90).
 *
 * Framework-agnostic on purpose: the order, the names and the arrow rule are
 * the design's, and a component should be able to render them without also
 * being the place they are decided.
 */
import type { PanelEdge } from '../../types'

/**
 * The six areas the navigation stack selects, in the design's own order.
 *
 * A mine is deliberately NOT one of them. The design keeps an opened mine
 * beside one of these rather than instead of one, so it is a second, concurrent
 * thing the shell holds — see `useView`.
 *
 * The Laboral Union is last because that is where the source puts it — after
 * Market, not alphabetically and not beside the two areas it happens to share
 * an unavailable panel with (#335).
 */
export const SHELL_AREAS = ['settings', 'map', 'mines', 'lab', 'market', 'laboral-union'] as const

export type ShellArea = (typeof SHELL_AREAS)[number]

export interface ShellNavItem {
  area: ShellArea
  /** The accessible name; the design's buttons carry an icon and no visible label. */
  label: string
}

export const SHELL_NAV: readonly ShellNavItem[] = [
  { area: 'settings', label: 'Settings' },
  { area: 'map', label: 'Map' },
  { area: 'mines', label: 'Mines' },
  { area: 'lab', label: 'Lab' },
  { area: 'market', label: 'Market' },
  { area: 'laboral-union', label: 'Laboral Union' }
]

export function isShellArea(value: unknown): value is ShellArea {
  return typeof value === 'string' && (SHELL_AREAS as readonly string[]).includes(value)
}

/**
 * The areas the design specifies as intentionally unavailable, and the one place
 * that list is written down (#335).
 *
 * All three carry the SAME overlay — `UnavailablePanel` — so the only thing that
 * distinguishes them is a painting and a sentence. Which is exactly why the list
 * is here rather than inferred in the shell's template: the fallback used to be
 * `area === 'lab' ? 'lab' : 'market'`, which answers "market" for every area
 * that is not the lab, and a third unavailable area is the point at which that
 * shape starts naming the wrong hall.
 */
export const UNAVAILABLE_AREAS = ['lab', 'market', 'laboral-union'] as const

export type UnavailableArea = (typeof UNAVAILABLE_AREAS)[number]

/**
 * The unavailable feature an area IS, or `undefined` when it has a screen of its
 * own. Undefined rather than a default, so an area added without a screen draws
 * nothing instead of claiming to be one of these three.
 */
export function unavailableAreaOf(area: ShellArea): UnavailableArea | undefined {
  return (UNAVAILABLE_AREAS as readonly ShellArea[]).includes(area)
    ? (area as UnavailableArea)
    : undefined
}

/**
 * Which way the rail's arrow points.
 *
 * Closed it points the way the panel will open — inward, away from the edge it
 * hangs on. Open it points back at that edge, which is where the panel goes
 * when it collapses. Both halves are drawn in the verified exports, and the
 * closed one is drawn for both edges.
 */
export function arrowDirection(edge: PanelEdge, expanded: boolean): PanelEdge {
  if (expanded) return edge
  return edge === 'right' ? 'left' : 'right'
}
