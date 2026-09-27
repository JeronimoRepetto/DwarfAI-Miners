/**
 * The shell's navigation areas (#90).
 *
 * Framework-agnostic on purpose: the order and the names are the design's, and
 * a component should be able to render them without also being the place they
 * are decided.
 */

/*
 * The six areas the navigation stack selects, `SHELL_AREAS`, and their `ShellArea` type stood here
 * until #635 (PANEL-QUESTIONS 25). They moved to `shared/contracts.ts` because the page the app
 * opens on is stored by main, which checks it against this list; re-exported here, through the
 * barrel, so every reader of the nav's areas keeps reading them from the nav.
 */
import { SHELL_AREAS, type ShellArea } from '../../types'

export { SHELL_AREAS, type ShellArea }

/*
 * `SHELL_NAV`, the v4 nav's single stack of the six areas in the source's
 * order, stood here until #635 and went with ShellNav.vue, its only reader. The
 * redesigned nav's groups are in `panelNav.ts`.
 */

/**
 * The areas the design specifies as intentionally unavailable, and the one place
 * that list is written down (#335).
 *
 * All three carry the SAME page — `GuildPage` since #635 — so the only thing that
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

/*
 * `arrowDirection` stood here until #635: which way the closed rail's arrow
 * pointed. The rail is gone (PO ruling 2026-09-27), and its arrow with it.
 */
