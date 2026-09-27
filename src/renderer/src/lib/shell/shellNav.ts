/**
 * The shell's navigation areas (#90).
 *
 * Framework-agnostic on purpose: the order and the names are the design's, and
 * a component should be able to render them without also being the place they
 * are decided.
 */

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
