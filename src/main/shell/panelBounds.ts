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

/** The design's mine interior. */
const MINE_INTERIOR_WIDTH = 245

/**
 * The chrome the CURRENT MineScene still wraps around the cave — its own
 * padding and the header row above it.
 *
 * A deliberate copy of `PANEL_CHROME.width` from the renderer's `sceneSizing`,
 * which main cannot import at runtime; `panelBounds.test.ts` holds the two equal
 * so it cannot drift. It is here because the mine interior's own rebuild is a
 * later slice: until then the design's 245px is the CAVE's width, and the column
 * has to be that plus the chrome the scene has not lost yet.
 */
export const MINE_SCENE_CHROME_WIDTH = 32

/** Air between the navigation column and the mine held open beyond it. */
const COLUMN_GAP = 8

/** The extra width an open mine costs the window. */
export const MINE_COLUMN_WIDTH = MINE_INTERIOR_WIDTH + MINE_SCENE_CHROME_WIDTH + COLUMN_GAP

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
