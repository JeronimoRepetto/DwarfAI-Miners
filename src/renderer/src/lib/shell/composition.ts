/**
 * Which of the shell's three compositions is on screen (#156).
 *
 * The shell is a BOOK: a rail, a navigation stack, a left page (the secondary
 * panel) and a right page (the opened mine), and either page can be closed
 * without the other. That is three compositions, not two — and reading
 * `expanded` alone can only tell two of them apart.
 *
 * The bug that produced this file: with a mine held open beyond a closed
 * secondary panel, `expanded` is false, so the shell classified itself as the
 * bare rail. It stopped painting the amber ground, the 8px padding and the
 * radius, which left a void where the navigation column stood, grew the interior
 * painting into the padding that was no longer reserved, and took the mine's
 * frame with it. The rail, reading the same flag, went on drawing the app mark
 * beside the navigation stack's own — the second icon floating in that void.
 *
 * So the composition is named ONCE, here, and every surface that has to know is
 * handed the answer rather than re-deriving it from a flag that cannot carry it.
 */

/**
 * `rail` is the collapsed strip with nothing drawn behind it. `mine` is the
 * design's own mine mock — rail, navigation stack, interior, and no left page.
 * `pages` is the left page open, with or without a mine beside it.
 */
export type ShellComposition = 'rail' | 'mine' | 'pages'

export function shellComposition(layout: {
  expanded: boolean
  mineOpen: boolean
}): ShellComposition {
  if (layout.expanded) return 'pages'
  return layout.mineOpen ? 'mine' : 'rail'
}
