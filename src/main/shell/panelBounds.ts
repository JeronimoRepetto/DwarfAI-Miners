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
 * The logical screen the whole shell is laid out on (#153).
 *
 * Type read far too small on a 2K display, and the maintainer's ruling is that
 * the shell is a SURFACE designed at 1080 logical pixels tall, scaled onto
 * whatever display it lands on. So every number below — the design's 20px rail,
 * its 38px navigation column, the derived columns — is computed against this
 * height and this height only, and the display's real one appears exactly once,
 * as the factor `uiScale` returns.
 *
 * Not the 768 the mock's own composition was drawn at: 768 is where the
 * design's stated widths are reproduced, 1080 is the screen the product is
 * scaled to. The two are different questions and both are answered here.
 */
export const DESIGN_SCREEN_HEIGHT = 1080

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
 * What the shell spends before any content column: 8px of padding at each end,
 * the 20px rail, the 38px navigation stack, and the 8px gap between the rail and
 * whatever comes next.
 */
const SHELL_FRAME_WIDTH = 2 * 8 + RAIL_WIDTH + 8 + 38

/**
 * What the shell spends on itself either side of the secondary column: the frame
 * above plus the second 8px gap, between the content and the navigation stack.
 */
export const SHELL_CHROME_WIDTH = SHELL_FRAME_WIDTH + 8

/**
 * The height the shell's own 8px padding leaves a painting, top and bottom.
 *
 * A deliberate copy of `SHELL_CONTENT_INSET` in the renderer's `sceneSizing`,
 * which main cannot import at runtime; `panelBounds.test.ts` holds the two
 * derivations equal so they cannot drift.
 */
const SHELL_CONTENT_INSET = 16

/**
 * What the map's own container spends before the painting sees any of its box,
 * on each axis: the design's 21px padding and 2px border, twice over.
 *
 * A deliberate copy of `--space-map-pad` and `--border-highlight`, which main
 * cannot read; `panelBounds.test.ts` pins it against the stylesheet itself.
 *
 * Counted here although `mineColumnWidth` deliberately does NOT count the
 * interior frame's border (#153), and the difference is not an inconsistency:
 * the mine column's width is set by `aspect-ratio` in the stylesheet, so main
 * has to reserve exactly what CSS derives or the two disagree. Nothing derives
 * the secondary column in CSS — it is `flex: 1` on whatever main gave the
 * window — so main is the only author of that width and can reserve the frame
 * that actually stands there (#165).
 */
export const MAP_FRAME_INSET = 2 * (21 + 2)

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
 *
 * The map's aspect is applied to the height the painting actually gets, not to
 * the whole content height (#165). The first version derived the column as if
 * the painting filled the column edge to edge; it does not, because the map
 * container's 21px padding and 2px border stand between them. The box the
 * painting was then drawn into was 46px shorter and 46px narrower than the one
 * the width was derived for, so its shape no longer matched the art and
 * `contain` letterboxed 11 design pixels of empty column above and below it.
 * Deriving from the inner box and adding the frame back makes the column hug
 * the painting, which is what the design's own container does.
 */
export function secondaryColumnWidth(windowHeight: number): number {
  const paintingHeight = contentHeight(windowHeight) - MAP_FRAME_INSET
  return Math.max(
    DESIGN_SECONDARY_WIDTH,
    Math.round(Math.max(0, paintingHeight) * MAP_ART_ASPECT) + MAP_FRAME_INSET
  )
}

/** The whole panel with no mine held open, on a window this tall. */
export function expandedWidth(windowHeight: number): number {
  return SHELL_CHROME_WIDTH + secondaryColumnWidth(windowHeight)
}

/**
 * The panel with a mine held open and no secondary panel beside it (#153).
 *
 * A state the shell did not have until the acceptance run separated the two
 * controls: the rail's arrow closes the SECONDARY panel, and a mine held open
 * stays held open. It is the design's own mine mock — rail, navigation stack,
 * interior, and nothing else — which is what `assets/mine/mine-interior.png`
 * draws.
 */
export function mineOnlyWidth(windowHeight: number): number {
  return SHELL_FRAME_WIDTH + mineColumnWidth(windowHeight)
}

/**
 * How much bigger than the design world this display is (#153).
 *
 * Continuous rather than quantised to whole numbers, which the maintainer chose
 * deliberately: a 1440p display comes out at 1.333, so a design pixel is not a
 * whole number of device pixels and the pixel art is resampled — and a panel
 * that is the RIGHT SIZE and slightly soft beats a crisp one that reads half the
 * size it should. 4K lands on exactly 2 and is pixel-perfect for free. A display
 * shorter than the design world scales DOWN by the same rule rather than being
 * left alone.
 *
 * Spent in exactly two places: the window's own width here, and the renderer's
 * `webContents.setZoomFactor` (see window.ts). Nothing else on the machine is
 * touched, which is the whole reason it is per-window zoom and not an OS
 * setting.
 */
export function uiScale(area: ScreenRect): number {
  if (area.height <= 0) return 1
  return area.height / DESIGN_SCREEN_HEIGHT
}

/**
 * How wide the window should be for this layout, in the display's own pixels.
 *
 * The whole composition is measured in the design world and multiplied once, so
 * the renderer keeps drawing the design's literal numbers and this is the only
 * place the display's real height is spent on a width.
 *
 * A display too narrow for the scaled composition gets a panel that spans it
 * rather than one that hangs off the side; the renderer's columns then shrink,
 * which is the honest failure mode for a size the design does not cover
 * (narrow-screen adaptation is Unspecified).
 */
export function panelWidth(area: ScreenRect, layout: PanelLayoutRequest): number {
  const scale = uiScale(area)
  if (!layout.expanded && !layout.mineOpen) {
    // The rail scales like everything else, but the platform floor is a real
    // pixel count and does not: a window cannot be made narrower than it.
    return Math.min(Math.max(MIN_WINDOW_WIDTH, Math.round(RAIL_WIDTH * scale)), area.width)
  }
  const design = layout.expanded
    ? expandedWidth(DESIGN_SCREEN_HEIGHT) +
      (layout.mineOpen ? mineColumnWidth(DESIGN_SCREEN_HEIGHT) : 0)
    : mineOnlyWidth(DESIGN_SCREEN_HEIGHT)
  return Math.min(Math.round(design * scale), area.width)
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
/**
 * The design's message panel: `990px` wide (`components.md`, "Dwarf message
 * panel"), and now the width of a window of its own (#162).
 */
export const MESSAGE_PANEL_DESIGN_WIDTH = 990

/**
 * Air between the shell and the panel standing beside it.
 *
 * Unspecified in the source. The mock leaves roughly 17px on its own 768-tall
 * composition, which is about 24 design pixels at 1080 — but it is a margin
 * nobody measured on purpose, so this takes the shell's OWN 8px gap
 * (`--space-nav-gap`, the same `COLUMN_GAP` the mine column is separated by)
 * rather than inventing a second spacing vocabulary for one edge.
 */
export const MESSAGE_PANEL_GAP = COLUMN_GAP

/**
 * How much room is left beside the shell, on the side away from the edge it is
 * docked to — the panel's own side, in the display's real pixels.
 *
 * Never negative: a shell that spans the whole display leaves nothing, which is
 * a real state on a small screen and not an error.
 */
function messagePanelRoom(area: ScreenRect, shell: ScreenRect, edge: PanelEdge): number {
  const gap = Math.round(MESSAGE_PANEL_GAP * uiScale(area))
  const room =
    edge === 'right' ? shell.x - area.x - gap : area.x + area.width - (shell.x + shell.width) - gap
  return Math.max(0, room)
}

/**
 * How wide the message panel's window should be, in the display's own pixels
 * (#162).
 *
 * ## What happens when the design's 990 does not fit
 *
 * The panel SHRINKS to the room beside the shell. It does not flip to the
 * shell's other side, and it does not fall back to #159's band docked inside
 * the shell — the two other candidates, both refused:
 *
 * - Flipping would move the panel across the desktop every time the shell
 *   grows, and the "other side" of a shell docked against a screen edge is off
 *   the display. It would also take the conversation away from the mine it is
 *   about, which is the one relation the design's mock draws.
 * - Re-docking inside the shell is exactly what this issue removes, and it
 *   would need the shell to grow to host the panel — the missing third
 *   dimension of `PanelLayoutRequest` that dies here.
 *
 * Shrinking is also already this file's answer to a composition a display
 * cannot hold (see `panelWidth`'s clamp), and it is what #159's docked band
 * shipped, so the narrowing is one the user has already met rather than a new
 * behaviour. It is self-explanatory too: the shell is what ate the room, and
 * collapsing the secondary panel with the rail gives it straight back.
 *
 * One floor, and it is the platform's rather than the design's: a window of no
 * width is not a narrow panel, it is a panel that looks as though it never
 * opened. `MIN_WINDOW_WIDTH` is the narrowest window Windows will actually
 * make (measured, see its own comment), so a display with less room than that
 * beside the shell gets a panel overlapping it by at most those 32 pixels.
 */
export function messagePanelWidth(area: ScreenRect, shell: ScreenRect, edge: PanelEdge): number {
  const design = Math.round(MESSAGE_PANEL_DESIGN_WIDTH * uiScale(area))
  const room = messagePanelRoom(area, shell, edge)
  return Math.min(area.width, Math.max(MIN_WINDOW_WIDTH, Math.min(design, room)))
}

/**
 * The message-panel window's rectangle, given where the shell actually is
 * (#162).
 *
 * Takes the shell's REAL bounds rather than re-deriving them, because that is
 * the rectangle the panel is placed against: a compositor that put the shell
 * somewhere else (see `applyPanelBounds`) moves the panel with it instead of
 * leaving the pair apart.
 *
 * `designHeight` is the panel's own height in DESIGN pixels — derived from the
 * latest message when it opens and then dragged (see the renderer's
 * `lib/message/panelHeight`) — multiplied here by the one factor `uiScale`
 * returns, exactly as every width in this file is. The bottom edge is what is
 * aligned, so a taller panel grows upward and the composition the mock draws
 * holds at any height.
 */
export function messagePanelBounds(
  area: ScreenRect,
  shell: ScreenRect,
  edge: PanelEdge,
  designHeight: number
): ScreenRect {
  const width = messagePanelWidth(area, shell, edge)
  const height = Math.min(area.height, Math.max(1, Math.round(designHeight * uiScale(area))))
  const gap = Math.round(MESSAGE_PANEL_GAP * uiScale(area))
  const x =
    edge === 'right'
      ? Math.max(area.x, shell.x - gap - width)
      : Math.min(area.x + area.width - width, shell.x + shell.width + gap)
  const bottom = Math.min(shell.y + shell.height, area.y + area.height)
  return { x, y: Math.max(area.y, bottom - height), width, height }
}
