import type { OpenMineId } from '../../types'

/**
 * Which mine INTERIOR is really on screen (#316).
 *
 * BOTH facts are needed and neither is enough, which is the whole reason this
 * is a named rule rather than a `&&` inside a component:
 *
 * - `mineId` is the shell's own navigation — the mine it is HOLDING open, which
 *   it holds a moment before main has given its column width, and held behind
 *   the closed rail until #635 removed the rail.
 * - `mineOpen` is main's report that the mine column was given width. It says a
 *   column is drawn; it cannot say which mine is in it, because it does not
 *   move when the person walks from one mine straight into another.
 *
 * Main is told the answer rather than deriving it for exactly that reason, and
 * #316's rule turns on it: a mine nobody can see must still be notified about.
 */
export function mineOnScreen(mineId: OpenMineId, layout: { mineOpen: boolean }): OpenMineId {
  return mineId !== null && layout.mineOpen ? mineId : null
}
