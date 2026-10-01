// Where the docked Panel sits and how wide it is (US-SHELL-004, US-SHELL-007; NFR-PLAT-12; 05 §3.14 `shell/panelBounds.ts`
// adapted, 21 §6). Pure arithmetic on a work area somebody else chose (`ScreenAreaProvider`), so every edge and every
// clamp is testable without a display. Nothing here names an operating system: the narrowest window a platform will
// make is a number the caller passes (`ElectronScreenArea.minWindowWidth`), never looked up here.
//
// ADAPTED for ISSUE-047 from the legacy `src/main/shell/panelBounds.ts`: the same grid and derivations, its own
// rectangle and layout types instead of the legacy domain's, and the platform's floor as a number instead of a
// `Platform` (R1: a domain imports nothing outside itself).

/** A rectangle in device-independent pixels (the shape of `Rect`, 16 §4.14, and of Electron's `Rectangle`). */
export interface ScreenRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The screen edge the Panel docks to (`PanelLayout.edge`, A-08/A-09; ADR-024 item 1 `dockSide`). */
export type PanelEdge = 'left' | 'right'

/** Which of the Panel's optional parts are open (`PanelLayout.mineOpen`, `PanelLayout.dockOpen`). */
export interface PanelColumns {
  readonly mineOpen: boolean
  readonly dockOpen: boolean
}

/**
 * The logical screen the whole shell is laid out on (#153): a surface 1080 design pixels tall, scaled onto whatever
 * display it lands on. Every width below is computed against this height; the display's real one appears once, as the
 * factor `uiScale` returns.
 */
export const DESIGN_SCREEN_HEIGHT = 1080

/** The short display the grid is measured against in the tests (the retired v4 mock's composition, #153). */
export const DESIGN_COMPOSITION_HEIGHT = 768

/** The nav column at the screen edge (`organisms/nav`, `.dm-nav`). */
export const NAV_WIDTH = 56

/** The page column: always 440px, cut at its far side on a screen narrower than the dock. */
export const PAGE_WIDTH = 440

/** The plate's own padding, and the gap between its columns (`.dm-shell`). */
export const SHELL_PADDING = 6
export const SHELL_GAP = 6

/**
 * The plate is held 2px off the screen edge so its edge shows (`.dm-shell` margin), and its material draws that same
 * 2px edge outside its box on every side (`.m-mat`). The window reserves it at both ends.
 */
export const SHELL_EDGE_MARGIN = 2

/** The gap between the plate and the dock's window slot (`.dm-dock`, gap 12px). */
export const DOCK_GAP = 12

/** The dock's window slot, as wide as what it holds: the history, the chat or the Add panel (440px), one at a time. */
export const DOCK_WIDTH = 440

/** What the slot's content draws outside its own box on the free side: its 2px edge and its raised 4px shadow. */
export const DOCK_FREE_ROOM = 6

/** The dock's inset from the top and the bottom of the work area (`.dm-dock`); the window still spans its height. */
export const DOCK_INSET = 12

/**
 * The height the shell spends before the mine column sees any of it: the dock's inset top and bottom, and the plate's
 * padding top and bottom. A deliberate copy of the renderer's `SHELL_CONTENT_INSET` (`sceneSizing`), held equal by
 * this module's tests.
 */
const SHELL_CONTENT_INSET = 2 * DOCK_INSET + 2 * SHELL_PADDING

/** The mine column's own chrome (`--chrome-h`, `organisms/mine-column`): toolbar plate, roster and footer. */
const MINE_COLUMN_CHROME_HEIGHT = 196

/** The narrowest mine column there is (US-SHELL-004.AC07); rock letterboxes the painting beyond it. */
export const MINE_COLUMN_MIN_WIDTH = 300

/** What the mine column adds to its painting's width (`calc(--art-w + 16px)`, US-SHELL-004.AC07). */
const MINE_COLUMN_ART_INSET = 16

/** The shell around the page: the edge margin at both ends, the padding at both ends, the nav and its gap. */
const SHELL_CHROME_WIDTH = 2 * SHELL_EDGE_MARGIN + 2 * SHELL_PADDING + NAV_WIDTH + SHELL_GAP

/** The mine interior painting, as the ratio its column is derived from. */
const INTERIOR_ART_ASPECT = 1184 / 3622

/** How wide the mine painting is drawn on a page this tall: whole, at the column's height less its chrome. */
export function paintingWidth(viewportHeight: number): number {
  return Math.max(
    0,
    Math.round(
      (viewportHeight - SHELL_CONTENT_INSET - MINE_COLUMN_CHROME_HEIGHT) * INTERIOR_ART_ASPECT
    )
  )
}

/**
 * How wide the open mine column is on a page this tall, with the gap that separates it from its neighbour: the
 * painting's width plus 16px, never narrower than 300px (US-SHELL-004.AC07).
 */
export function mineColumnWidth(viewportHeight: number): number {
  return (
    Math.max(MINE_COLUMN_MIN_WIDTH, paintingWidth(viewportHeight) + MINE_COLUMN_ART_INSET) +
    SHELL_GAP
  )
}

/** The page column: one width whatever the page shows (#635). A function of the height for its callers. */
export function secondaryColumnWidth(_viewportHeight: number): number {
  return PAGE_WIDTH
}

/** The Panel with nothing beside its page: the nav and the page on the plate, the narrowest the window is. */
export function panelBaseWidth(viewportHeight: number): number {
  return SHELL_CHROME_WIDTH + secondaryColumnWidth(viewportHeight)
}

/**
 * What the dock's window slot adds while it holds something: the gap, less the plate's free-side edge that the gap now
 * holds, the slot, and the room the slot's own raised material is drawn in beyond it.
 */
export function dockSlotWidth(): number {
  return DOCK_GAP - SHELL_EDGE_MARGIN + DOCK_WIDTH + DOCK_FREE_ROOM
}

/**
 * How much bigger than the design world this display is (#153): its usable height against 1080, continuous rather
 * than quantised, so 1440p is sized right rather than crisp. Spent on the window's width here and on the page's zoom
 * (`applyUiScale`), nowhere else.
 */
export function uiScale(area: ScreenRect): number {
  if (area.height <= 0) return 1
  return area.height / DESIGN_SCREEN_HEIGHT
}

/**
 * How wide the window is for these columns, in the display's own pixels.
 *
 * The sum is the whole rule (#635): the nav and the page, the mine column while a mine is open (US-SHELL-004.AC04,
 * AC07), the window slot while something is docked (US-SHELL-004.AC05), and nothing else. It is measured in the design
 * world at the height `zoom` leaves the page (the renderer's `100vh`) and multiplied once.
 *
 * The work area's width is the last word: the dock is never wider than the screen, however many parts are open
 * (US-SHELL-007.AC04), and the page gives way (NFR-PLAT-12). `floor` is the narrowest window the platform makes, a
 * real pixel count that does not scale; it never lifts the width past the work area.
 */
export function panelWidth(
  area: ScreenRect,
  layout: PanelColumns,
  floor = 0,
  zoom: number = uiScale(area)
): number {
  const viewportHeight = zoom > 0 ? area.height / zoom : DESIGN_SCREEN_HEIGHT
  const design =
    panelBaseWidth(viewportHeight) +
    (layout.mineOpen ? mineColumnWidth(viewportHeight) : 0) +
    (layout.dockOpen ? dockSlotWidth() : 0)
  const scaled = Math.max(floor, Math.round(design * zoom))
  return Math.min(scaled, area.width)
}

/**
 * The columns a window this wide can actually hold (#635, window fit). A window that did not reach the width asked of
 * it is reported as the widest layout it has room for, never as the request: the window slot goes before the mine, and
 * a column nobody asked for is never added. A window `panelWidth` itself clamped to its work area was given exactly
 * what it was asked for.
 */
export function layoutThatFits(
  area: ScreenRect,
  layout: PanelColumns,
  appliedWidth: number,
  floor = 0,
  zoom: number = uiScale(area)
): PanelColumns {
  const candidates: PanelColumns[] = [
    { mineOpen: layout.mineOpen, dockOpen: layout.dockOpen },
    { mineOpen: layout.mineOpen, dockOpen: false },
    { mineOpen: false, dockOpen: false }
  ]
  const held = candidates.find(
    (candidate) => panelWidth(area, candidate, floor, zoom) <= appliedWidth
  )
  return held ?? { mineOpen: false, dockOpen: false }
}

/**
 * The window rectangle for these columns on this work area. The docked edge never moves: a right-docked Panel keeps
 * its right edge against the screen and grows leftward, toward the free side.
 */
export function panelBounds(
  area: ScreenRect,
  edge: PanelEdge,
  layout: PanelColumns,
  floor = 0,
  zoom: number = uiScale(area)
): ScreenRect {
  const width = panelWidth(area, layout, floor, zoom)
  return {
    x: edge === 'right' ? area.x + area.width - width : area.x,
    y: area.y,
    width,
    height: area.height
  }
}
