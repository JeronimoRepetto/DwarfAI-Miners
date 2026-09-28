/**
 * Where the docked shell sits and how wide it is (#90).
 *
 * Pure arithmetic on a rectangle somebody else chose (see
 * `platform/screenArea.ts`, which is where this file's per-OS story lives), so
 * every edge and every clamp is testable without a display.
 *
 * One number in it does differ per OS — the narrowest window a platform will
 * actually make — and it is not a constant here either: every function that can
 * reach that floor takes a `Platform` and asks `platform/windowMetrics.ts` for
 * it, so a macOS width is assertable from a Windows host like everything else.
 */
import type { Platform } from '../platform/platform'
import type { ScreenRect } from '../platform/screenArea'
import { minWindowWidth } from '../platform/windowMetrics'
import type { PanelEdge, PanelLayoutRequest } from '../domain/types'

/*
 * `RAIL_WIDTH` stood here until #635: the closed 20px rail, which the design never draws and the
 * PO's ruling of 2026-09-27 removed. Closing the Panel hides its window, as the app mark always
 * did, so no composition is narrower than the nav and the page any more.
 *
 * `MIN_WINDOW_WIDTH` stood here until #465. It was a Windows MEASUREMENT (#153)
 * that every platform paid. The floors, per platform and with the ones still
 * unmeasured said so, are now `minWindowWidth` in `platform/windowMetrics.ts`.
 */

/**
 * The display the retired v4 mock's composition was drawn for (#153). Nothing
 * below is derived at it since #635; it stays as the short display the tests
 * measure the grid against.
 */
export const DESIGN_COMPOSITION_HEIGHT = 768

/**
 * The logical screen the whole shell is laid out on (#153).
 *
 * Type read far too small on a 2K display, and the maintainer's ruling is that
 * the shell is a SURFACE designed at 1080 logical pixels tall, scaled onto
 * whatever display it lands on. So every number below — the nav, the page,
 * the dock slot, the derived columns — is computed against this
 * height and this height only, and the display's real one appears exactly once,
 * as the factor `uiScale` returns.
 *
 * Not the 768 the mock's own composition was drawn at: 768 is where the
 * design's stated widths are reproduced, 1080 is the screen the product is
 * scaled to. The two are different questions and both are answered here.
 */
export const DESIGN_SCREEN_HEIGHT = 1080

/**
 * The redesigned Panel's grid (#635), in design pixels: `screens/shell.md`,
 * Layout and Parts, which the renderer's stylesheet draws literally.
 *
 * One rock plate docked against the screen edge, holding from the edge inward
 * the nav, the mine column while a mine is open, and the page, and beyond the
 * plate on its free side the dock's window slot while something is docked in it.
 * The page and the nav are always there; the mine column takes no space while
 * no mine is open, and the window slot none while it holds nothing (Layout).
 * The window is exactly as wide as that, and not a pixel is reserved for what
 * is not shown (PO ruling 2026-09-27).
 */
/** The nav column at the screen edge (`organisms/nav`, `.dm-nav`). */
export const NAV_WIDTH = 56

/** The page column: always 440px, cut at its far side on a screen narrower than the dock. */
export const PAGE_WIDTH = 440

/*
 * `DESIGN_SECONDARY_WIDTH` (555) and `MAP_FRAME_INSET` stood here until #635:
 * the floor of a secondary column that followed the map painting's own shape,
 * and the map container's frame that shape was derived inside (#153, #165).
 * The redesign gives the page one width whatever it shows, so both went with
 * the derivation.
 */

/** The plate's own padding, and the gap between its columns (`.dm-shell`). */
export const SHELL_PADDING = 6
export const SHELL_GAP = 6

/**
 * The plate is held 2px off the screen edge so its edge shows (`.dm-shell`
 * margin), and its material draws that same 2px edge outside its box on every
 * side (`.m-mat`). The window reserves it at both ends: at the docked end it is
 * the design's margin, and at the free end it is the room the plate's own edge
 * is painted into — without it, the free side of the frame would fall outside
 * the window.
 */
export const SHELL_EDGE_MARGIN = 2

/**
 * The gap between the plate and the dock's window slot (`.dm-dock`, gap 12px).
 * The plate's own free-side edge is drawn inside it.
 */
export const DOCK_GAP = 12

/**
 * The dock's window slot, as wide as what it holds (#635): the mine history
 * today (`.dm-hist`, width 440px), and the MessagePanel and the Add panel
 * (`.dm-msg`, 440px) once their own slice docks them. It holds one at a time.
 */
export const DOCK_WIDTH = 440

/**
 * What the slot's content draws outside its own box, reserved on the window's
 * free side while the slot is open: its material's 2px edge (`.m-mat`) and its
 * raised 4px drop shadow (`.m-raised`). The shadow falls toward the free side
 * of a left dock only, but it is reserved on both edges alike: one composition
 * is one window width, whichever side it is docked to.
 */
export const DOCK_FREE_ROOM = 6

/**
 * The dock's inset from the top and the bottom of the work area (`.dm-dock`).
 * The window still spans the work area's whole height: the renderer draws the
 * plate inside it, so the window's own vertical geometry, and every platform's
 * placement of it, is unchanged.
 */
export const DOCK_INSET = 12

/**
 * The height the shell spends before the mine column sees any of it: the
 * dock's inset top and bottom, and the plate's padding top and bottom.
 *
 * A deliberate copy of `SHELL_CONTENT_INSET` in the renderer's `sceneSizing`,
 * which main cannot import at runtime; `panelBounds.test.ts` holds the two
 * derivations equal so they cannot drift.
 */
const SHELL_CONTENT_INSET = 2 * DOCK_INSET + 2 * SHELL_PADDING

/**
 * The mine column's own chrome (`--chrome-h`, `organisms/mine-column`): its
 * toolbar plate, roster and footer, which the painting is drawn beside.
 */
const MINE_COLUMN_CHROME_HEIGHT = 196

/** The narrowest mine column there is; rock letterboxes the painting beyond it. */
export const MINE_COLUMN_MIN_WIDTH = 300

/** What the mine column adds to its painting's width (`calc(--art-w + 16px)`). */
const MINE_COLUMN_ART_INSET = 16

/**
 * What the shell spends on itself around the page: the edge margin at both
 * ends, the plate's padding at both ends, the nav, and the gap between the nav
 * and whatever stands beside it.
 */
const SHELL_CHROME_WIDTH = 2 * SHELL_EDGE_MARGIN + 2 * SHELL_PADDING + NAV_WIDTH + SHELL_GAP

/** The two paintings, as the ratios their columns are derived from. */
const INTERIOR_ART_ASPECT = 1184 / 3622

/**
 * How wide the mine column is on a window this tall, with the gap that
 * separates it from its neighbour (`screens/shell.md`, Layout).
 *
 * The painting is drawn whole at the column's height less its chrome, at its
 * own aspect; the column is that width plus 16px and never narrower than
 * 300px. At the design screen's own height the floor is what wins.
 */
export function mineColumnWidth(windowHeight: number): number {
  const art = Math.max(
    0,
    Math.round(
      (windowHeight - SHELL_CONTENT_INSET - MINE_COLUMN_CHROME_HEIGHT) * INTERIOR_ART_ASPECT
    )
  )
  return Math.max(MINE_COLUMN_MIN_WIDTH, art + MINE_COLUMN_ART_INSET) + SHELL_GAP
}

/**
 * The page column. One width whatever the page shows (#635): the map,
 * the mines, Settings and the guild pages are all drawn in the same 440px.
 * Still a function of the height for its callers, which ask it per height.
 */
export function secondaryColumnWidth(_windowHeight: number): number {
  return PAGE_WIDTH
}

/**
 * The Panel with nothing beside its page: the nav and the page on the plate,
 * the narrowest the window is while it shows since #635 removed the rail.
 */
export function panelBaseWidth(windowHeight: number): number {
  return SHELL_CHROME_WIDTH + secondaryColumnWidth(windowHeight)
}

/**
 * What the dock's window slot adds while it holds something (#635): the gap,
 * less the plate's free-side edge that the gap now holds, the slot, and the
 * room the slot's own raised material is drawn in beyond it.
 */
export function dockSlotWidth(): number {
  return DOCK_GAP - SHELL_EDGE_MARGIN + DOCK_WIDTH + DOCK_FREE_ROOM
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
 * The sum is the whole rule (#635): the nav and the page, the mine column while
 * a mine is open, the dock slot while something is docked, and nothing else.
 *
 * A display too narrow for the scaled composition gets a panel that spans it
 * rather than one that hangs off the side (decision log, Narrow screen: the
 * dock is never wider than the screen); the renderer's page column then gives
 * way. The platform floor is a real pixel count that does not scale: a window
 * cannot be made narrower than it, so a display whose scale would shrink the
 * Panel below it still asks for that floor (#465).
 *
 * `zoom` is the factor the page ACTUALLY has (`applyUiScale`'s read-back), and
 * the mine column is derived at the height that zoom leaves the page — the
 * window's height over it, which is exactly the renderer's `100vh` (#635). It
 * is `uiScale`'s own factor on any page that took it, where that height is the
 * design screen's 1080; a page whose zoom is anything else draws a different
 * column, and deriving it at 1080 regardless is how main came to reserve a
 * column the renderer did not draw, cutting the page beside it.
 */
export function panelWidth(
  area: ScreenRect,
  layout: Pick<PanelLayoutRequest, 'mineOpen' | 'dockOpen'>,
  platform?: Platform,
  zoom: number = uiScale(area)
): number {
  const viewportHeight = zoom > 0 ? area.height / zoom : DESIGN_SCREEN_HEIGHT
  const design =
    panelBaseWidth(viewportHeight) +
    (layout.mineOpen ? mineColumnWidth(viewportHeight) : 0) +
    (layout.dockOpen ? dockSlotWidth() : 0)
  const scaled = Math.max(minWindowWidth(platform), Math.round(design * zoom))
  return Math.min(scaled, area.width)
}

/**
 * The layout a window this wide can actually hold (#635, window fit).
 *
 * The renderer draws the columns main reports, so a window that did not reach
 * the width asked of it — a window manager refusing the grow, a compositor
 * clamping it — is reported as the widest layout it has room for, never as the
 * request: drawn into a window without room, the mine column would push the
 * page, the one column that gives way, off the window's free side.
 *
 * The dock goes before the mine, because what it holds today is that mine's
 * history; the nav and the page are always there. A column nobody asked for is
 * never added, and the narrow-screen rule is unchanged: a window `panelWidth`
 * itself clamped to its display was given exactly what it was asked for.
 */
export function layoutThatFits(
  area: ScreenRect,
  layout: Pick<PanelLayoutRequest, 'mineOpen' | 'dockOpen'>,
  appliedWidth: number,
  platform?: Platform,
  zoom: number = uiScale(area)
): Pick<PanelLayoutRequest, 'mineOpen' | 'dockOpen'> {
  const candidates = [
    { mineOpen: layout.mineOpen, dockOpen: layout.dockOpen },
    { mineOpen: layout.mineOpen, dockOpen: false },
    { mineOpen: false, dockOpen: false }
  ]
  const held = candidates.find(
    (candidate) => panelWidth(area, candidate, platform, zoom) <= appliedWidth
  )
  return held ?? { mineOpen: false, dockOpen: false }
}

/**
 * The window rectangle for this layout on this display.
 *
 * The docked edge never moves: a right-docked panel keeps its right edge against
 * the screen and grows leftward, toward the free side the dock slot opens on.
 */
export function panelBounds(
  area: ScreenRect,
  edge: PanelEdge,
  layout: Pick<PanelLayoutRequest, 'mineOpen' | 'dockOpen'>,
  platform?: Platform,
  zoom: number = uiScale(area)
): ScreenRect {
  const width = panelWidth(area, layout, platform, zoom)
  return {
    x: edge === 'right' ? area.x + area.width - width : area.x,
    y: area.y,
    width,
    height: area.height
  }
}
/*
 * REMOVED for #635, stated rather than passing unseen: the message panel's own window's rectangle
 * (#162, #296) — its design width and the gap beside the shell, the room it had, its docked
 * bounds, the anchor a moved panel was remembered by, the detached width and bounds, the clamp
 * back onto a display and the placement that chose between them. The decision log anchors the
 * MessagePanel and the Add panel in the Panel, in the dock's window slot, whose width this file
 * reserves with the rest of the shell (DOCK_WIDTH, dockSlotWidth).
 */
