// The Panel window's read-backs over narrow `BrowserWindow` slices (05 §3.14 `ElectronWindows` ← `shell/window.ts`;
// kept from today's helpers, ISSUE-047). One rule runs through all of them: Electron only forwards a request, and the OS,
// the window manager or the page may decline it, so each answers what the window or the page ACTUALLY is afterwards,
// never what was asked (ADR-024 item 9; 13 FM-051, FM-052). Pure over the slices they take, so a test drives each one
// with a fake that refuses or adjusts the change the way a platform would.
import { uiScale, type ScreenRect } from '../domain/panelBounds'

/** The slice of `BrowserWindow` the pin needs (#35). */
export interface AlwaysOnTopTarget {
  setAlwaysOnTop: (flag: boolean) => void
  isAlwaysOnTop: () => boolean
}

/**
 * Applies the requested pin and reports what the window ACTUALLY is now. On macOS the flag maps to the `floating`
 * level; on Linux it is an EWMH above-hint a window manager may ignore (notably some Wayland compositors); Windows
 * honours it. A refusal reads back `false` the same way on every OS (FM-052, NFR-PLAT-04).
 */
export function applyAlwaysOnTop(target: AlwaysOnTopTarget, pinned: boolean): boolean {
  target.setAlwaysOnTop(pinned)
  return target.isAlwaysOnTop()
}

type ZoomMode = 'default' | 'isolated' | 'manual' | 'disabled'

/** The slice of `webContents` the UI scale needs (#153). */
export interface UiScaleTarget {
  setZoomFactor: (factor: number) => void
  getZoomFactor: () => number
  getZoomMode: () => ZoomMode
  setZoomMode: (mode: ZoomMode) => void
}

/**
 * How close two zoom factors have to be to be the same factor: Chromium stores zoom as a logarithmic level and answers
 * `1.2 ** level`, so a page reports the factor it was given give or take the last bit (#388).
 */
const ZOOM_FACTOR_EPSILON = 1e-9

/**
 * Zooms the page to `wanted` and reports the factor it ACTUALLY got. Per page, not per origin (#635): Chromium shares
 * one zoom between every page of an origin by default, and `setZoomMode('isolated')` (which persists across
 * navigations) is Electron's documented way out. Asked only when the answer would change (#388); the read-back
 * decides, so a page that lost its zoom to a navigation gets it back.
 */
export function applyZoomFactor(target: UiScaleTarget, wanted: number): number {
  if (target.getZoomMode() !== 'isolated') target.setZoomMode('isolated')
  if (Math.abs(target.getZoomFactor() - wanted) > ZOOM_FACTOR_EPSILON) target.setZoomFactor(wanted)
  return target.getZoomFactor()
}

/**
 * Scales the whole shell onto this work area (#153): the same factor `panelWidth` multiplies by, so main never reserves
 * columns the renderer does not draw. Reports the factor the page ACTUALLY got.
 */
export function applyUiScale(target: UiScaleTarget, area: ScreenRect): number {
  return applyZoomFactor(target, uiScale(area))
}

/** The slice of `BrowserWindow` the docked bounds need (#90). */
export interface PanelBoundsTarget {
  setBounds: (bounds: ScreenRect) => void
  getBounds: () => ScreenRect
}

/** Moves the window and reports where it ACTUALLY ended up: a compositor may place it elsewhere (FM-051). */
export function applyPanelBounds(target: PanelBoundsTarget, bounds: ScreenRect): ScreenRect {
  target.setBounds(bounds)
  return target.getBounds()
}

/** The slice of `BrowserWindow` a raise needs (#165). */
export interface RaiseTarget {
  isVisible: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  moveTop: () => void
  focus: () => void
}

/**
 * Brings the Panel to the front and gives it focus (#165): a frameless transparent window is not reliably raised by the
 * platform's own click-to-front, so a click on it is reported (A-02) and answered here. `moveTop` then `focus`, because
 * one is z-order and the other keyboard focus; a minimized window is restored first. A HIDDEN window is left hidden:
 * hidden is the tray state, and a click cannot have landed on it (US-SHELL-002.AC05).
 */
export function raisePanelWindow(target: RaiseTarget): void {
  if (!target.isVisible()) return
  if (target.isMinimized()) target.restore()
  target.moveTop()
  target.focus()
}
