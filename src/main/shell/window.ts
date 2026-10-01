import {
  BrowserWindow,
  app,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import type { PanelEdge, PanelLayout, PanelLayoutRequest } from '../domain/types'
import { currentPlatform, type Platform } from '../platform/platform'
import { panelScreenArea, type ScreenRect } from '../platform/screenArea'
import { layoutThatFits, panelBounds, uiScale } from './panelBounds'
import { resolveResourcePath } from './resourcePaths'

let mainWindow: BrowserWindow | null = null
let quitting = false

/** The design names Right as the default side; the left/right choice is Settings' (a later slice). */
const DEFAULT_PANEL_EDGE: PanelEdge = 'right'

/**
 * What the shell window currently IS. Held here because it is the window's own
 * state: the renderer reads it back over the bridge rather than keeping a second
 * copy that could disagree with the bounds Electron actually applied.
 */
let layout: PanelLayout = { edge: DEFAULT_PANEL_EDGE, mineOpen: false, dockOpen: false }

/**
 * The columns the window, as it last ended up, can actually hold (#635, window fit): `layout`
 * less whatever a refused grow left no room for. What the renderer is told, so it never draws a
 * column into a window without room for it; `layout` stays the request, so the next fit — a
 * show, a display change — asks for the whole of it again. `null` while no window has been
 * fitted to the current request, when the request is all there is to report.
 */
let held: Pick<PanelLayout, 'mineOpen' | 'dockOpen'> | null = null

/** Flip the close handler from "hide" to "really close" (called on before-quit). */
export function markQuitting(): void {
  quitting = true
}

/*
 * REMOVED for #635, stated rather than passing unseen: `shellDebugEnabled` and the SHELL_DEBUG
 * switch (#312). It narrated what main did to the message panel's own window — created hidden,
 * revealed by a height report, placed, closed — and that window is gone; the shell's own fit is
 * logged on every apply regardless (formatShellFit).
 */

/** One fact on a diagnostic line. `null` is an absence worth printing. */
type ShellTraceFact = string | number | boolean | ScreenRect | null

/**
 * One fact as a single field with no space in it: a rectangle, the one geometry this file logs,
 * folded into `WxH@X,Y`. AMENDED for #635 (was: also the two-number anchor a moved message panel
 * was remembered by, gone with its window).
 */
function traceFact(fact: ShellTraceFact): string {
  if (fact === null) return 'none'
  if (typeof fact !== 'object') return String(fact)
  return `${fact.width}x${fact.height}@${fact.x},${fact.y}`
}

/**
 * One diagnostic line: the subject, the moment, and the facts that separate
 * this occurrence from the one that worked.
 *
 * Pure, so what a line SAYS is assertable without a display — every moment it
 * describes happens inside Electron and none of them can be reached from a
 * unit test. A rectangle is folded into a single field because two lines from
 * one run are read side by side, and an absent value prints as `none` rather
 * than being left off: a missing anchor is the answer to a question, not the
 * absence of one.
 */
export function formatShellTrace(moment: string, facts: Record<string, ShellTraceFact>): string {
  const fields = Object.entries(facts).map(([name, fact]) => `${name}=${traceFact(fact)}`)
  return fields.length === 0 ? `[shell] ${moment}` : `[shell] ${moment}: ${fields.join(' ')}`
}

/**
 * The slice of BrowserWindow the pin control needs (see #35). Narrow on
 * purpose: tests drive applyAlwaysOnTop with a deterministic fake instead of a
 * real window, and the wiring passes the real BrowserWindow, which satisfies
 * this shape structurally.
 */
export interface AlwaysOnTopTarget {
  setAlwaysOnTop: (flag: boolean) => void
  isAlwaysOnTop: () => boolean
}

/**
 * Apply the requested pin state and report what the window ACTUALLY is now.
 * The read-back is the whole point: the renderer must render this verdict,
 * never the request, because the platform can decline the change — Electron
 * only forwards the hint. On macOS the flag maps to the 'floating' window
 * level by default (above normal windows, below screen-saver-level panels);
 * on Linux it becomes an EWMH above-hint that the window manager is free to
 * ignore, notably under some Wayland compositors. Windows honors it directly.
 */
export function applyAlwaysOnTop(target: AlwaysOnTopTarget, pinned: boolean): boolean {
  target.setAlwaysOnTop(pinned)
  return target.isAlwaysOnTop()
}

export interface MainWindowOptionsInput {
  /** The persisted pin preference, applied from the very first frame (see #35). */
  alwaysOnTop: boolean
  preloadPath: string
  iconPath: string
  /** Where the Panel hangs on the display it is docked to (see #90). */
  bounds: ScreenRect
}

/**
 * Pure options builder, split from createMainWindow so the creation-time
 * contract — the stored pin preference lands in `alwaysOnTop`, the frameless
 * floating-panel flags stay fixed, the window opens on the bounds it is handed — is
 * testable without an Electron runtime.
 */
export function buildMainWindowOptions(
  input: MainWindowOptionsInput
): BrowserWindowConstructorOptions {
  return {
    ...input.bounds,
    show: false,
    frame: false,
    transparent: true,
    /*
     * The redesigned shell is DOCKED (#90): its rectangle is derived from the
     * display and from whether the panel is open, so there is no size for a
     * user to drag and nothing for a drag to mean. This replaces the
     * minWidth/minHeight floor issue #44 added to the old free-floating panel;
     * the guarantee that floor existed for — the cave never being drawn below
     * the box its anchors were authored in — now lives in panelBounds.ts, which
     * is where the cave's column is sized.
     */
    resizable: false,
    /*
     * Windows keeps the WS_THICKFRAME style on a frameless window unless told
     * otherwise, and with it the DWM's window-size animation — so every
     * `setBounds` a layout change issues redrew the WHOLE shell in one flash,
     * including the columns a layout change had left exactly where they were
     * (#394). Electron documents `false` as removing "window shadow and window
     * animations" and edge-drag resizing: the window is not resizable, and the
     * shell paints its own shadow, so nothing this app relies on goes with it.
     * Windows-only by definition; the other platforms ignore it.
     */
    thickFrame: false,
    /*
     * The shell paints its own shadow, and `thickFrame: false` above takes the
     * native one on Windows only — it is a Windows style and nothing else reads
     * it. macOS keeps drawing its own around the shape a TRANSPARENT window
     * presents, and the shell's fold clips that shape while the window stays
     * the full height, so what the OS outlined was a rectangle the fill no
     * longer reached: a second shadow standing past the painted plate (#465,
     * photographed on the closed rail #635 has since removed). Electron's own
     * `invalidateShadow()` documents transparent windows leaving exactly these
     * artifacts on macOS; refusing the shadow outright beats repainting it
     * after every animation, because the plate's own material is the one
     * meant to be seen.
     */
    hasShadow: false,
    skipTaskbar: true,
    /*
     * Stated rather than left to Electron's default (#165). The third
     * acceptance run found the shell sitting BEHIND whatever program had the
     * foreground, alive and taking clicks but never raised, and `focusable` is
     * the one option that would make `raisePanelWindow` below a no-op with
     * nothing on screen to say so. A frameless panel invites exactly the kind
     * of "it does not need focus" reasoning that sets this to false; it does
     * need it, and now the test says so.
     */
    focusable: true,
    alwaysOnTop: input.alwaysOnTop,
    icon: input.iconPath,
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /*
       * The music starts on its own (#174), and Chromium's default autoplay
       * policy forbids exactly that: audio may not start on a page that has
       * had no user gesture. This window is created HIDDEN and revealed by a
       * global shortcut or the tray icon, neither of which is a gesture on
       * the page, so there is no click for the policy to be satisfied by —
       * and the failure is a rejected `play()` promise with nothing on
       * screen to say so, which is silence nobody could diagnose.
       *
       * `'no-user-gesture-required'` is Electron's own documented switch
       * for it. This is the app's one window (#635), so it is the one page
       * the switch is set on.
       */
      autoplayPolicy: 'no-user-gesture-required'
    }
  }
}

/**
 * The slice of BrowserWindow the docked shell needs. Narrow for the same reason
 * AlwaysOnTopTarget is: the read-back is what the renderer is told, so a test
 * drives it with a fake that can refuse or adjust the move the way a window
 * manager would.
 */
export interface PanelBoundsTarget {
  setBounds: (bounds: ScreenRect) => void
  getBounds: () => ScreenRect
}

/**
 * Move the window and report where it ACTUALLY ended up. Same rule as
 * applyAlwaysOnTop: Electron only forwards the request, and a compositor may
 * place the window somewhere else — the renderer must be told what happened.
 */
export function applyPanelBounds(target: PanelBoundsTarget, bounds: ScreenRect): ScreenRect {
  target.setBounds(bounds)
  return target.getBounds()
}

/**
 * The slice of `webContents` the UI scale needs (#153). Narrow for the same
 * reason the two above are: a test drives it with a fake, and the read-back is
 * what main then trusts.
 */
export interface UiScaleTarget {
  setZoomFactor: (factor: number) => void
  getZoomFactor: () => number
  getZoomMode: () => 'default' | 'isolated' | 'manual' | 'disabled'
  setZoomMode: (mode: 'default' | 'isolated' | 'manual' | 'disabled') => void
}

/**
 * How close two zoom factors have to be to be the same factor.
 *
 * Chromium stores zoom as a logarithmic LEVEL and answers with `1.2 ** level`,
 * so a page reports the factor it was given back give or take the last bit. An
 * exact comparison would therefore never match on any display but the design
 * world's own, and nothing would ever be skipped.
 */
const ZOOM_FACTOR_EPSILON = 1e-9

/**
 * Scale the whole shell onto this display and report the factor the page
 * ACTUALLY got.
 *
 * The shell is laid out as a surface 1080 logical pixels tall (see
 * DESIGN_SCREEN_HEIGHT) and this is the one thing that makes it the display's
 * size instead: per-window zoom, so nothing else on the machine moves. It has to
 * be the SAME factor `panelWidth` multiplied by, which is why both read it from
 * `uiScale` rather than each deriving one — a disagreement there would have main
 * reserving columns the renderer does not draw, and nothing would say so until
 * something clipped.
 */
export function applyUiScale(target: UiScaleTarget, area: ScreenRect): number {
  const wanted = uiScale(area)
  // Per page, not per origin (#635). Chromium shares a zoom between every page of one origin by
  // default, and the shell and the message panel load the same page — so the panel, scaled for
  // the display it is on, used to zoom the shell too. Electron's `setZoomLevel` names
  // `setZoomMode('isolated')` as the way out, and that mode persists across navigations.
  if (target.getZoomMode() !== 'isolated') target.setZoomMode('isolated')
  // Asked only when the answer would change (#388). `setPanelLayout` re-applies
  // the scale on every layout change, because a layout change can carry the
  // window onto another display — and most of them do not, so most of these
  // are a write of the value the page already has, landing in the frame the
  // shell's fold is animating in. The READ-BACK decides, which keeps the one
  // case that matters: a page that lost its zoom to a navigation still gets it
  // back (see the loadURL handler below).
  if (Math.abs(target.getZoomFactor() - wanted) > ZOOM_FACTOR_EPSILON) target.setZoomFactor(wanted)
  return target.getZoomFactor()
}

/** The slice of BrowserWindow a whole fit needs: its bounds and its page's zoom. */
export interface ShellWindowTarget extends PanelBoundsTarget {
  webContents: UiScaleTarget
}

/** What one fit of the shell window came to, in the display's own pixels. */
export interface ShellFit {
  /** The columns the window it ended up as can hold, which is what the renderer is told. */
  held: Pick<PanelLayout, 'mineOpen' | 'dockOpen'>
  /** The zoom the page actually has. */
  zoom: number
  requestedWidth: number
  appliedWidth: number
}

/**
 * Fit the shell window to a layout, and report what it can hold (#635, window fit).
 *
 * The zoom first, because the mine column is derived at the height it leaves
 * the page; then the bounds sized at that zoom; then the read-back. A window
 * that did not reach the width is asked once more for the layout it CAN hold,
 * so the docked edge stays against the screen and no column is drawn into room
 * that is not there (see `layoutThatFits`).
 */
export function fitShellWindow(
  target: ShellWindowTarget,
  area: ScreenRect,
  layout: PanelLayout,
  platform?: Platform
): ShellFit {
  const zoom = applyUiScale(target.webContents, area)
  const requested = panelBounds(area, layout.edge, layout, platform, zoom)
  let applied = applyPanelBounds(target, requested)
  const held = layoutThatFits(area, layout, applied.width, platform, zoom)
  if (held.mineOpen !== layout.mineOpen || held.dockOpen !== layout.dockOpen) {
    applied = applyPanelBounds(target, panelBounds(area, layout.edge, held, platform, zoom))
  }
  return { held, zoom, requestedWidth: requested.width, appliedWidth: applied.width }
}

/**
 * The slice of BrowserWindow a raise needs. Narrow for the reason the three
 * above are: the whole of the decision is testable with a fake that records
 * what was asked of it, in the order it was asked.
 */
export interface RaiseTarget {
  isVisible: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  moveTop: () => void
  focus: () => void
}

/**
 * Bring the shell to the front and give it focus (#165).
 *
 * ## Why this has to exist
 *
 * The third acceptance run found the panel sitting BEHIND whatever program had
 * the foreground: alive, visible, receiving the click, and never raised. The
 * shell is a frameless TRANSPARENT window — a layered window on Windows — which
 * is the combination the platform's own click-to-front does not reliably apply,
 * and nothing in the app compensated. Until this, the only `focus()` in the
 * whole process was `showPanel`'s, so the sole way to raise the panel was to
 * hide it and summon it again.
 *
 * The maintainer's rule is one sentence: a click anywhere on the shell raises
 * and focuses it, pinned or not, like any normal window. Pinning is a separate
 * question — it decides whether the panel STAYS above other windows, not
 * whether a click may bring it there — so nothing here reads it.
 *
 * ## The order, and the one refusal
 *
 * `moveTop` then `focus`, because they are different asks: one is z-order and
 * the other is keyboard focus, and a window focused underneath another is
 * exactly the state that was photographed. A minimized window is restored
 * first, or there is nothing to raise.
 *
 * A HIDDEN window is left hidden. Hidden is the tray state, and a click cannot
 * have landed on a window nobody can see — so a stray call would otherwise
 * become a way for the renderer to reopen the panel behind the user's back.
 */
export function raisePanelWindow(target: RaiseTarget): void {
  if (!target.isVisible()) return
  if (target.isMinimized()) target.restore()
  target.moveTop()
  target.focus()
}

/** The screen rectangle the panel may cover, on the display it is currently on. */
function currentScreenArea(): ScreenRect {
  const display =
    mainWindow === null
      ? screen.getPrimaryDisplay()
      : screen.getDisplayMatching(mainWindow.getBounds())
  return panelScreenArea(display, currentPlatform())
}

/** What the shell window is right now (see #90) — read, never requested. */
export function panelLayout(): PanelLayout {
  return { ...layout, ...held }
}

/** Which columns a layout names, as one word for a diagnostic line. */
function columnsWord(columns: Pick<PanelLayout, 'mineOpen' | 'dockOpen'>): string {
  if (columns.mineOpen && columns.dockOpen) return 'mine+dock'
  if (columns.mineOpen) return 'mine'
  if (columns.dockOpen) return 'dock'
  return 'page'
}

/**
 * The line every fit of the shell prints (#635, window fit).
 *
 * The cut Panel the PO reported could not be reproduced on the one display it
 * was checked on, so a run that goes wrong on another has to say why by
 * itself: the work area, the zoom the page got, the width asked and the width
 * the window became — in the display's pixels and in the renderer's CSS
 * pixels, which is where the grid is drawn — the columns asked and held, and
 * how many displays there are. Geometry and counts only: nothing on it names a
 * person, a path or a project. Printed on every fit rather than behind a
 * debug switch, because a fit happens on a click, not on a frame.
 */
export function formatShellFit(
  area: ScreenRect,
  fit: ShellFit,
  asked: Pick<PanelLayout, 'mineOpen' | 'dockOpen'>,
  displays: number
): string {
  const tenths = (value: number): number => Math.round(value * 10) / 10
  return formatShellTrace('layout applied', {
    area,
    zoom: Math.round(fit.zoom * 10_000) / 10_000,
    requested: fit.requestedWidth,
    applied: fit.appliedWidth,
    requestedCss: tenths(fit.requestedWidth / fit.zoom),
    appliedCss: tenths(fit.appliedWidth / fit.zoom),
    asked: columnsWord(asked),
    held: columnsWord(fit.held),
    displays
  })
}

/**
 * What a display change does to the window (#635, window fit).
 *
 * A resolution or scale change, a monitor plugged in or out, or a taskbar
 * appearing leaves the shell sized and zoomed for a display that is no longer
 * there, and until the window fit it waited for the next layout change or
 * show. It is refitted hidden as well as shown — a bounds change shows
 * nothing, and the show path fits it again regardless. AMENDED for #635, the
 * MessagePanel slice (was: the shell, then the message panel's own window
 * placed against it): the panel is in the shell's dock slot, so the shell is
 * all there is to refit.
 */
export function refitOnDisplayChange(steps: { fitShell: () => void }): () => void {
  return () => {
    steps.fitShell()
  }
}

/**
 * Fit the shell window to the current layout on the display it is on, and hold what it can
 * hold (#635). The one path every resize of the shell takes — a layout change, a show, a
 * display change — so the renderer is never told a layout the window was not given.
 */
function fitShell(): void {
  if (mainWindow === null) return
  const area = currentScreenArea()
  const fit = fitShellWindow(mainWindow, area, layout, currentPlatform())
  held = fit.held
  console.log(formatShellFit(area, fit, layout, screen.getAllDisplays().length))
}

/**
 * Adopt a persisted edge before any window exists (#138) — index.ts calls
 * this with the Settings position preference right after loading it, mirroring
 * how the pin preference reaches createMainWindow's `alwaysOnTop` option. The
 * very first frame then opens on the user's chosen side instead of always
 * starting 'right' and jumping the moment the renderer syncs.
 */
export function seedPanelEdge(edge: PanelEdge): void {
  layout = { ...layout, edge }
}

/**
 * Apply a layout the renderer asked for and answer with what the window became.
 *
 * `edge` is optional (#138): omitting it keeps the CURRENT edge, which is what
 * a mine opening and the dock opening both do — neither is the Settings
 * position control, and neither may nudge the docked side as a side effect.
 * Only a request that names one (the position control) ever moves it.
 */
export function setPanelLayout(request: PanelLayoutRequest): PanelLayout {
  layout = {
    edge: request.edge ?? layout.edge,
    mineOpen: request.mineOpen,
    dockOpen: request.dockOpen
  }
  held = null
  if (mainWindow !== null) {
    // Re-scaled as well as re-sized: a layout change can move the window onto
    // another display, and the zoom belongs to the display rather than to the
    // window that happens to be on it. Sized with the zoom the page GOT, and
    // reported as what the window it became can hold (#635).
    fitShell()
  }
  return panelLayout()
}

export function createMainWindow(options: { alwaysOnTop: boolean }): BrowserWindow {
  mainWindow = new BrowserWindow(
    buildMainWindowOptions({
      alwaysOnTop: options.alwaysOnTop,
      bounds: panelBounds(
        panelScreenArea(screen.getPrimaryDisplay(), currentPlatform()),
        layout.edge,
        layout
      ),
      preloadPath: join(import.meta.dirname, '../preload/index.cjs'),
      // Windows and Linux use this for the taskbar/Alt-Tab icon; Electron
      // ignores it on macOS, where the app bundle's own icon applies instead
      // (and this app hides its Dock tile regardless — see app.dock?.hide()).
      iconPath: resolveResourcePath('app-icon.png', {
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      })
    })
  )

  /*
   * The scale lands BEFORE the first paint (#153): the window is created with
   * `show: false` and only revealed by showPanel, and Electron resets a page's
   * zoom on every navigation — so setting it as soon as the document is ready is
   * both the earliest moment it survives and one that nobody can see. Setting it
   * before the load would be discarded; setting it after `show()` would flash
   * the whole shell at 1x on a 4K display.
   */
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow === null) return
    applyUiScale(mainWindow.webContents, currentScreenArea())
  })

  // Closing the window only hides it; the app keeps running in the tray.
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  // Any external navigation opens in the default browser, never in the panel.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  /*
   * Refit the shell when the displays change under it (#635 window fit, see
   * refitOnDisplayChange). Registered here because this runs once, with the
   * one window it refits.
   */
  const refitDisplays = refitOnDisplayChange({ fitShell })
  screen.on('display-metrics-changed', refitDisplays)
  screen.on('display-added', refitDisplays)
  screen.on('display-removed', refitDisplays)

  // The page is NOT loaded here (#570) — see loadPanelPage below for why.
  return mainWindow
}

/**
 * The slice of BrowserWindow the panel's own page load needs. Narrow like the
 * targets above it: the branch below is asserted with a fake, because the
 * real BrowserWindow this is aimed at in production cannot be built outside
 * an actual Electron process at all (`require('electron')` resolves to the
 * path of its binary there, not the module).
 */
export interface PanelPageTarget {
  loadURL: (url: string) => void
  loadFile: (filePath: string) => void
}

/**
 * Dev server or packaged file — the one branch a panel window's page load
 * ever takes, split out of createMainWindow so it is assertable on its own
 * (#570).
 */
export function applyPanelPageLoad(
  target: PanelPageTarget,
  env: NodeJS.ProcessEnv = process.env
): void {
  const devServerUrl = env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    void target.loadURL(devServerUrl)
  } else {
    void target.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

/**
 * Load the shell's own page against the live window (#570).
 *
 * This used to happen inside createMainWindow itself, fire-and-forget, right
 * after the window was built — several hundred lines before index.ts
 * registered its OWN last `ipcMain.handle`. A renderer fast enough to mount
 * before that registration finished invoked `mines:get` on a channel nobody
 * was listening on yet, and Electron rejected the call as "No handler
 * registered for channel": silent in `pnpm dev`, where the dev server's own
 * page load is slow enough to lose that race almost every time, and reliable
 * in a packaged build, where `loadFile` reads local bytes off disk and wins
 * it — which is why the bug shipped invisibly until a package build exposed
 * it.
 *
 * The fix is ordering, not a retry or a queued call: index.ts now calls this
 * exactly once, after its whole IPC surface is registered, so there is no
 * channel left for an early invoke to find missing. A no-op with no window,
 * like showPanel guards.
 */
export function loadPanelPage(): void {
  if (mainWindow === null) return
  applyPanelPageLoad(mainWindow)
}

export function showPanel(): void {
  if (!mainWindow) return
  // Re-derived on every show: a docked panel that was hidden across a
  // resolution change, a docking event or a display being unplugged would
  // otherwise come back sized for a screen that is no longer there — and, since
  // #153, scaled for one too.
  fitShell()
  mainWindow.show()
  // Shown is not RAISED (#165): the same frameless-transparent window that a
  // click does not bring forward can also come back underneath whatever had the
  // foreground while it was hidden. One rule, one function, both entry points.
  raisePanelWindow(mainWindow)
  // AMENDED for #635 (was: the message panel's own window shown with the
  // shell when a surface was open): the chat and the Add panel are in the
  // shell's dock slot, so they come back with it and go away with it, and the
  // tray and the global shortcut still mean the app's one window.
}

export function hidePanel(): void {
  mainWindow?.hide()
}

export function togglePanel(): void {
  if (!mainWindow) return
  if (mainWindow.isVisible()) {
    hidePanel()
  } else {
    showPanel()
  }
}
/*
 * REMOVED for #635, stated rather than passing unseen: the message panel's own window (#162) and
 * everything that only served it — its options builder and its creation, the surface main held
 * for both windows, the selection focus it took (#409), its height report and the reveal that
 * waited on it (#312), the deferred hide that waited on its surface settling (#389), the header
 * drag and the dock-back and the position they remembered (#296), its placement beside the shell
 * or where it was left, and the pin it mirrored. The decision log anchors the MessagePanel and
 * the Add panel in the Panel, and they mount in this window's dock slot, which main sizes with the
 * rest of the shell (panelBounds.ts, dockSlotWidth).
 *
 * The keyboard reaches the composer the way it reaches every other control of the shell: the
 * window is created focusable (buildMainWindowOptions), a press anywhere on it raises and focuses
 * it (raisePanelWindow, through raiseWindowOf), and a dwarf is selected by a press on the shell.
 */

/** The shell's page, for the pushes main owes it. Null before it exists. */
export function shellWebContents(): WebContents | null {
  if (mainWindow === null || mainWindow.webContents.isDestroyed()) return null
  return mainWindow.webContents
}

/**
 * Raise and focus the window that sent a click (#162, #165).
 *
 * The shell reports every press on itself because a frameless transparent
 * window is not reliably raised by the platform's own click-to-front. Answered
 * for the SENDER, which since #635 is always the shell: the message panel that
 * was a second window of the same kind is in its dock slot now.
 */
export function raiseWindowOf(contents: WebContents): void {
  const target = BrowserWindow.fromWebContents(contents)
  if (target !== null) raisePanelWindow(target)
}
