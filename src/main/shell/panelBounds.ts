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
 * The narrowest window the platform will actually make.
 *
 * Measured, not assumed (#153): on Windows a BrowserWindow asked for 20px comes
 * back 32px wide, which is a left/right asymmetry rather than a rounding — a
 * right-docked rail's extra twelve pixels hang off the screen and it still looks
 * like the design's 20px rail, a left-docked one's do not and it comes out fat.
 * Asking for the floor makes both edges the same window; the renderer draws the
 * design's 20px rail against the docked side of it and leaves the rest clear.
 */
export const MIN_WINDOW_WIDTH = 32

/**
 * The display the design's composition was drawn for, and the height every
 * derived column below reproduces the design's own numbers at.
 */
export const DESIGN_COMPOSITION_HEIGHT = 768

/**
 * The secondary content column of the design's own 645px opening width, which
 * is now the FLOOR rather than the value.
 *
 * The verified `assets/shell/` export with no mine open is 645px wide, and the
 * renderer spends it on a 20px gutter for the collapse arrow, a 38px navigation
 * column, the 8px padding and gaps between them, and the secondary panel taking
 * whatever is left — 555 of it. A display too short for the fit rule to want
 * that much still gets it, because a panel narrower than the composition it was
 * drawn for is not a smaller version of the design, it is a broken one.
 */
export const DESIGN_SECONDARY_WIDTH = 555

/**
 * What the shell spends on itself either side of the secondary column: 8px of
 * padding at each end, the 20px rail, the 38px navigation stack, and the 8px
 * gap on each side of the content.
 */
export const SHELL_CHROME_WIDTH = 2 * 8 + RAIL_WIDTH + 2 * 8 + 38

/**
 * The height the shell's own 8px padding leaves a painting, top and bottom.
 *
 * A deliberate copy of `SHELL_CONTENT_INSET` in the renderer's `sceneSizing`,
 * which main cannot import at runtime; `panelBounds.test.ts` holds the two
 * derivations equal so they cannot drift.
 */
const SHELL_CONTENT_INSET = 16

/** The two paintings, as the ratios their columns are derived from. */
const INTERIOR_ART_ASPECT = 1184 / 3622
const MAP_ART_ASPECT = 1856 / 2304

/** Air between the navigation column and the mine held open beyond it. */
const COLUMN_GAP = 8

function contentHeight(windowHeight: number): number {
  return windowHeight - SHELL_CONTENT_INSET
}

/**
 * How wide the mine column is on a window this tall — the acceptance ruling's
 * one fit rule (#153), evaluated for the interior painting.
 *
 * The painting is drawn at the FULL HEIGHT of the shell's content area with its
 * aspect preserved and nothing cropped, so the column's width follows the
 * height. The design's 245px is what this returns at the mock's own 768-tall
 * composition; it was never a constant, and reserving it on a 1392-tall display
 * is what made the interior read tiny. The gap that separates the column from
 * the navigation is the whole of the rest.
 */
export function mineColumnWidth(windowHeight: number): number {
  return Math.max(0, Math.round(contentHeight(windowHeight) * INTERIOR_ART_ASPECT)) + COLUMN_GAP
}

/**
 * The same rule for the map painting, which lives in the secondary column.
 *
 * Floored at the design's own content width: a short display would otherwise
 * derive a column narrower than the composition the mines list, the settings
 * screen and the two unavailable panels were drawn in, none of which is a map.
 * Above the floor the column follows the map's height, so the whole painting is
 * visible without a crop — which is the correction itself.
 */
export function secondaryColumnWidth(windowHeight: number): number {
  return Math.max(DESIGN_SECONDARY_WIDTH, Math.round(contentHeight(windowHeight) * MAP_ART_ASPECT))
}

/** The whole panel with no mine held open, on a window this tall. */
export function expandedWidth(windowHeight: number): number {
  return SHELL_CHROME_WIDTH + secondaryColumnWidth(windowHeight)
}

/**
 * How wide the window should be for this layout, never wider than the display.
 *
 * A display too narrow for the whole composition gets a panel that spans it
 * rather than one that hangs off the side; the renderer's columns then shrink,
 * which is the honest failure mode for a size the design does not cover
 * (narrow-screen adaptation is Unspecified).
 */
export function panelWidth(area: ScreenRect, layout: PanelLayoutRequest): number {
  if (!layout.expanded) return Math.min(MIN_WINDOW_WIDTH, area.width)
  const wanted = expandedWidth(area.height) + (layout.mineOpen ? mineColumnWidth(area.height) : 0)
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
