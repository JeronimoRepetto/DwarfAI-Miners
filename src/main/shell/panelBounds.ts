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
 * The gutter along the panel's free edge, holding the arrow that collapses it
 * back to the rail. The design gives the arrow itself as 20px wide.
 */
const COLLAPSE_GUTTER = 20

/**
 * The navigation column on the panel's outer edge: a 19px icon centred in the
 * frame's own margin, which the verified export draws at 37-38px.
 */
const NAV_COLUMN_WIDTH = 38

/**
 * The content column the secondary panel is drawn in.
 *
 * The design marks the panel's opening width **Unspecified**, so this is
 * derived, not transcribed: the verified `assets/shell/` exports are 1:1 with
 * the spec (the closed rail measures exactly 20px in the same set, and the mine
 * column exactly its stated 245px), and the no-mine export is 645px wide. Take
 * the gutter and the nav column off that and the content column is what is left.
 */
const CONTENT_COLUMN_WIDTH = 587

/** The whole panel with no mine held open: the export's own 645px. */
export const EXPANDED_WIDTH = COLLAPSE_GUTTER + CONTENT_COLUMN_WIDTH + NAV_COLUMN_WIDTH

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
