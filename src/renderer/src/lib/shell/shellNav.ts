/**
 * The shell's navigation stack, and which way its arrow points (#90).
 *
 * Framework-agnostic on purpose: the order, the names and the arrow rule are
 * the design's, and a component should be able to render them without also
 * being the place they are decided.
 */
import type { PanelEdge } from '../../types'

/**
 * The five areas the navigation stack selects, in the design's own order.
 *
 * A mine is deliberately NOT one of them. The design keeps an opened mine
 * beside one of these rather than instead of one, so it is a second, concurrent
 * thing the shell holds — see `useView`.
 */
export const SHELL_AREAS = ['settings', 'map', 'mines', 'lab', 'market'] as const

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
  { area: 'market', label: 'Market' }
]

export function isShellArea(value: unknown): value is ShellArea {
  return typeof value === 'string' && (SHELL_AREAS as readonly string[]).includes(value)
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
