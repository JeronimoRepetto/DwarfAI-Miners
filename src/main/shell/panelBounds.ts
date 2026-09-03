/**
 * Where the docked shell sits and how wide it is (#90).
 *
 * Pure arithmetic on a rectangle somebody else chose (see
 * `platform/screenArea.ts`, which is the only thing here that knows an OS), so
 * every edge and every clamp is testable without a display.
 */
import type { ScreenRect } from '../platform/screenArea'
import type { PanelEdge, PanelLayoutRequest } from '../domain/types'

/** The design's closed rail: 20px, spanning the usable screen height. */
export const RAIL_WIDTH = 20

/**
 * The whole panel with no mine held open.
 *
 * The design marks the panel's opening width **Unspecified**, so this is
 * derived, not transcribed. The verified `assets/shell/` exports are 1:1 with
 * the spec — the closed rail measures exactly its stated 20px in the same set,
 * and the mine column exactly its stated 245px — and the export with no mine
 * open is 645px wide.
 *
 * The renderer spends it: a 20px gutter for the collapse arrow, a 38px
 * navigation column, and the secondary panel taking whatever is left. Only the
 * total is main's business.
 */
export const EXPANDED_WIDTH = 645

/**
 * The design's mine interior, and since #137 the whole of the mine column.
 *
 * A deliberate copy of `DESIGN_INTERIOR_WIDTH` in the renderer's `sceneSizing`,
 * which main cannot import at runtime; `panelBounds.test.ts` holds the two
 * equal so it cannot drift. Both are the `--size-mine-interior-width` token.
 */
export const MINE_INTERIOR_WIDTH = 245

/** Air between the navigation column and the mine held open beyond it. */
const COLUMN_GAP = 8

/**
 * The extra width an open mine costs the window.
 *
 * The interior and nothing else. Until #137 this carried 32px more for the
 * header row and padding the old cave scene wrapped around itself; the design's
 * interior has no such chrome — it is the painting, with the Close and Add
 * actions floating on top of it — so the column is exactly the 245px the design
 * states, plus the gap that separates it from the navigation.
 */
export const MINE_COLUMN_WIDTH = MINE_INTERIOR_WIDTH + COLUMN_GAP

/**
 * How wide the window should be for this layout, never wider than the display.
 *
 * A display too narrow for the whole composition gets a panel that spans it
 * rather than one that hangs off the side; the renderer's columns then shrink,
 * which is the honest failure mode for a size the design does not cover
 * (narrow-screen adaptation is Unspecified).
 */
export function panelWidth(area: ScreenRect, layout: PanelLayoutRequest): number {
  if (!layout.expanded) return RAIL_WIDTH
  const wanted = EXPANDED_WIDTH + (layout.mineOpen ? MINE_COLUMN_WIDTH : 0)
  return Math.min(wanted, area.width)
}

/**
 * The window rectangle for this layout on this display.
 *
 * The docked edge never moves: a right-docked panel keeps its right edge against
 * the screen and grows leftward, which is the direction the rail's arrow points.
 */
export function panelBounds(
  area: ScreenRect,
  edge: PanelEdge,
  layout: PanelLayoutRequest
): ScreenRect {
  const width = panelWidth(area, layout)
  return {
    x: edge === 'right' ? area.x + area.width - width : area.x,
    y: area.y,
    width,
    height: area.height
  }
}
