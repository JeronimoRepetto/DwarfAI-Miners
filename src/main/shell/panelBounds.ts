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

/** The design's closed rail: 20px, spanning the usable screen height. */
export const RAIL_WIDTH = 20

/*
 * `MIN_WINDOW_WIDTH` stood here until #465. It was a Windows MEASUREMENT (#153)
 * that every platform paid: on a Mac the collapsed window came out wider than
 * the rail the renderer paints into it, and macOS drew its own shadow round the
 * transparent gutter that left. The floors, per platform and with the one still
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
 * The redesigned Panel's grid (#635), in design pixels: `screens/shell.md`,
 * Layout and Parts, which the renderer's stylesheet draws literally.
 *
 * One rock plate docked against the screen edge, holding from the edge inward
 * the nav, the mine column while a mine is open, and the page. The page and the
 * nav are always there; the mine column takes no space while no mine is open.
 * The MessagePanel's dock slot is not part of this window yet: today's panel
 * is still its own window beside the shell until its own slice replaces it.
 *
 * The closed 20px rail (#388) is not in the design — it is what Veta retires —
 * and until then it stays exactly as it was: the free-side column of every
 * open composition, and the whole window when nothing else is drawn.
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
 * What the shell spends before any content column: the edge margin at both
 * ends, the plate's padding at both ends, the nav, the rail, and the gap
 * between the nav and whatever stands beside it.
 */
const SHELL_FRAME_WIDTH =
  2 * SHELL_EDGE_MARGIN + 2 * SHELL_PADDING + NAV_WIDTH + RAIL_WIDTH + SHELL_GAP

/**
 * What the shell spends on itself around the page: the frame above plus the
 * gap between the page and the rail.
 */
export const SHELL_CHROME_WIDTH = SHELL_FRAME_WIDTH + SHELL_GAP

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

/** The whole panel with no mine held open, on a window this tall. */
export function expandedWidth(windowHeight: number): number {
  return SHELL_CHROME_WIDTH + secondaryColumnWidth(windowHeight)
}

/**
 * The panel with a mine held open and the page closed (#153): the rail's
 * arrow closes the PAGE, and a mine held open stays held open. The rail keeps
 * doing exactly that until Veta retires it; the redesign itself never closes
 * the page.
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
export function panelWidth(
  area: ScreenRect,
  layout: PanelLayoutRequest,
  platform?: Platform
): number {
  const scale = uiScale(area)
  if (!layout.expanded && !layout.mineOpen) {
    // The rail scales like everything else, but the platform floor is a real
    // pixel count and does not: a window cannot be made narrower than it. Where
    // the floor is wider than the scaled rail the difference is transparent
    // window, so it is asked for per platform rather than at the widest (#465).
    return Math.min(Math.max(minWindowWidth(platform), Math.round(RAIL_WIDTH * scale)), area.width)
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
  layout: PanelLayoutRequest,
  platform?: Platform
): ScreenRect {
  const width = panelWidth(area, layout, platform)
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
 * (`--space-nav-gap`, the gap the mine column was separated by until #635)
 * rather than inventing a second spacing vocabulary for one edge.
 *
 * Kept at 8 when the shell's own gap became the redesign's 6 (#635): today's
 * message panel is replaced whole by its own slice, which docks it inside the
 * Panel, and moving it by two pixels on the way would be a change nobody asked
 * that slice to review.
 */
export const MESSAGE_PANEL_GAP = 8

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
 * opened. `minWindowWidth` is the narrowest window this platform will actually
 * make (see its own comment), so a display with less room than that beside the
 * shell gets a panel overlapping it by at most that floor.
 */
export function messagePanelWidth(
  area: ScreenRect,
  shell: ScreenRect,
  edge: PanelEdge,
  platform?: Platform
): number {
  const design = Math.round(MESSAGE_PANEL_DESIGN_WIDTH * uiScale(area))
  const room = messagePanelRoom(area, shell, edge)
  return Math.min(area.width, Math.max(minWindowWidth(platform), Math.min(design, room)))
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
  designHeight: number,
  platform?: Platform
): ScreenRect {
  const width = messagePanelWidth(area, shell, edge, platform)
  const height = Math.min(area.height, Math.max(1, Math.round(designHeight * uiScale(area))))
  const gap = Math.round(MESSAGE_PANEL_GAP * uiScale(area))
  const x =
    edge === 'right'
      ? Math.max(area.x, shell.x - gap - width)
      : Math.min(area.x + area.width - width, shell.x + shell.width + gap)
  const bottom = Math.min(shell.y + shell.height, area.y + area.height)
  return { x, y: Math.max(area.y, bottom - height), width, height }
}

/**
 * Where a message-panel window the person MOVED is anchored (#296).
 *
 * Two numbers rather than a whole rectangle, because only two of the four are
 * the person's: the width is still the design's own 990 scaled onto the
 * display, and the height is still whatever the panel last measured of itself
 * (the design's vertical-only resize, see `messagePanelBounds`). Storing a
 * rectangle would mean storing a width and a height nothing may honour and
 * inviting a later reader to honour them anyway.
 *
 * `bottom` rather than a top edge, for the reason the docked panel aligns on
 * its bottom: a taller panel grows UPWARD, so the bottom is the edge that
 * stays put across a height report and the top is the one that follows.
 */
export interface MessagePanelAnchor {
  /** Its left edge, in the display coordinates Electron's bounds speak. */
  x: number
  /** Its BOTTOM edge, which is the one a height change leaves alone. */
  bottom: number
}

/** The anchor of a rectangle — what main records once a drag has ended. */
export function messagePanelAnchorOf(rect: ScreenRect): MessagePanelAnchor {
  return { x: rect.x, bottom: rect.y + rect.height }
}

/**
 * How wide a DETACHED message panel is: the design's own 990, scaled, and
 * nothing to do with the shell (#296).
 *
 * `messagePanelWidth` shrinks to the room beside the shell, which is the honest
 * answer for a panel placed against it — the shell is what ate the room. A
 * panel the person carried somewhere else is not placed against anything, so
 * that reasoning does not reach it: it gets the design's width, and the only
 * two limits left are the display it is on and the narrowest window the
 * platform will actually make.
 */
export function detachedMessagePanelWidth(area: ScreenRect, platform?: Platform): number {
  const design = Math.round(MESSAGE_PANEL_DESIGN_WIDTH * uiScale(area))
  return Math.min(area.width, Math.max(minWindowWidth(platform), design))
}

/** Pull one value back between two bounds; the bounds win over the value. */
function within(value: number, low: number, high: number): number {
  return Math.min(Math.max(Math.round(value), low), high)
}

/**
 * Keep a rectangle inside the work area it is meant to be on (#296).
 *
 * Run on EVERY apply rather than only at the end of a drag: the display the
 * panel sits on can change under it — a resolution change, a monitor
 * unplugged, a taskbar appearing — and a window whose position was recorded
 * once is a window that can be off-screen with no gesture involved. The size
 * is clamped before the origin, because a rectangle bigger than the area has
 * no origin that would fit it.
 */
export function clampMessagePanelBounds(
  area: ScreenRect,
  rect: ScreenRect,
  platform?: Platform
): ScreenRect {
  const width = Math.min(area.width, Math.max(minWindowWidth(platform), Math.round(rect.width)))
  const height = Math.min(area.height, Math.max(1, Math.round(rect.height)))
  return {
    x: within(rect.x, area.x, area.x + area.width - width),
    y: within(rect.y, area.y, area.y + area.height - height),
    width,
    height
  }
}

/**
 * The rectangle a stored anchor asks for on this display, or `null` when the
 * anchor no longer means anything here (#296).
 *
 * The refusal is the interesting half. A position is remembered across
 * restarts and across display changes, so it can name a place that is simply
 * gone: the second monitor it was dragged onto was unplugged, or the
 * resolution shrank under it. Clamping such an anchor would still produce a
 * rectangle on screen — but one nobody chose, at a corner of a display the
 * panel was never on, which reads as the app having moved the panel by itself.
 * Answering `null` lets the caller fall back to the docked placement, which is
 * a place the person has seen the panel before.
 *
 * The test is whether the asked-for rectangle still TOUCHES the work area, and
 * it is deliberately generous: a panel dragged mostly off the right edge is a
 * panel somebody put there, and it is clamped back into view rather than
 * disowned.
 */
export function detachedMessagePanelBounds(
  area: ScreenRect,
  anchor: MessagePanelAnchor,
  designHeight: number,
  platform?: Platform
): ScreenRect | null {
  if (area.width <= 0 || area.height <= 0) return null
  const width = detachedMessagePanelWidth(area, platform)
  const height = Math.min(area.height, Math.max(1, Math.round(designHeight * uiScale(area))))
  const asked = { x: Math.round(anchor.x), y: Math.round(anchor.bottom) - height, width, height }
  const touches =
    asked.x < area.x + area.width &&
    asked.x + asked.width > area.x &&
    asked.y < area.y + area.height &&
    asked.y + asked.height > area.y
  return touches ? clampMessagePanelBounds(area, asked, platform) : null
}

/**
 * Where the message-panel window goes: beside the shell, or where the person
 * put it (#296).
 *
 * The one decision this whole issue is about, and it is here rather than in the
 * window so that it can be asserted without a display. An anchor means the
 * panel has been MOVED, and a moved panel stops following the shell — the shell
 * changing side, growing for a mine, or being re-placed on another display no
 * longer drags the conversation across the desktop with it. What still reaches
 * a detached panel is its own height (the design's vertical-only resize, which
 * grows it upward from the anchored bottom edge) and the clamp above.
 *
 * With no anchor this is exactly `messagePanelBounds`, which is what opening
 * the panel does: docked until moved, so the first open is the composition the
 * design's own mock draws and nothing has to be learned to get it.
 */
export function messagePanelPlacement(
  area: ScreenRect,
  shell: ScreenRect,
  edge: PanelEdge,
  designHeight: number,
  anchor: MessagePanelAnchor | null,
  platform?: Platform
): ScreenRect {
  const detached =
    anchor === null ? null : detachedMessagePanelBounds(area, anchor, designHeight, platform)
  return detached ?? messagePanelBounds(area, shell, edge, designHeight, platform)
}
