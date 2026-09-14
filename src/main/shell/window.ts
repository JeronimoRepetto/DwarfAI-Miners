import {
  BrowserWindow,
  app,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import type {
  MessagePanelDragPhase,
  MessagePanelState,
  MessagePanelSurface,
  PanelEdge,
  PanelLayout,
  PanelLayoutRequest
} from '../domain/types'
import { MESSAGE_PANEL_SURFACE, RENDERER_SURFACE_PARAM } from '../domain/types'
import { currentPlatform } from '../platform/platform'
import { panelScreenArea, type ScreenRect } from '../platform/screenArea'
import { emptyMessagePanel } from './messagePanelState'
import {
  clampMessagePanelBounds,
  detachedMessagePanelBounds,
  messagePanelAnchorOf,
  messagePanelPlacement,
  panelBounds,
  uiScale,
  type MessagePanelAnchor
} from './panelBounds'
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
let layout: PanelLayout = { edge: DEFAULT_PANEL_EDGE, expanded: false, mineOpen: false }

/** Flip the close handler from "hide" to "really close" (called on before-quit). */
export function markQuitting(): void {
  quitting = true
}

/**
 * Debug-only visibility switch for what main does to its two windows (#312).
 *
 * The first message-panel open of a run went wrong in complete silence, and
 * that silence is the reason this exists: the panel window is created HIDDEN
 * and revealed only by the renderer's first height report, and every step on
 * the way there that can decline does so with a bare `return` — an anchor
 * dropped because it no longer reaches a display, a height report arriving
 * while there is no window or no open surface, the window's own close handler
 * firing. A whole failing run produced not one line from main, so there was
 * nothing to tell those four apart from each other.
 *
 * Mirrors `perf.ts`'s DWARFAI_PERF, `tierService.ts`'s TIER_DEBUG and
 * `codexProvider.ts`'s CODEX_DEBUG — read straight from process.env rather than
 * AppConfig, because this is a debugging device rather than a product setting
 * and it must be usable without a config round trip (`SHELL_DEBUG=1 pnpm dev`).
 * Read per call rather than at import time, like the latter two, so a `.env`
 * entry works in a dev checkout.
 */
const SHELL_DEBUG_ENV_VAR = 'SHELL_DEBUG'

/** Whether this process narrates what it does to its two windows. */
export function shellDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SHELL_DEBUG_ENV_VAR]
  if (raw === undefined) return false
  const normalized = raw.toLowerCase()
  return normalized === '1' || normalized === 'true'
}

/** One fact on a diagnostic line. `null` is an absence worth printing. */
type ShellTraceFact = string | number | boolean | ScreenRect | MessagePanelAnchor | null

/**
 * One fact as a single field with no space in it.
 *
 * The two geometries this file logs are the only two it has: a whole rectangle
 * and the two-number anchor a moved panel is remembered by (see
 * `MessagePanelAnchor`, which is deliberately not a rectangle). They are told
 * apart by the edge only one of them names, so a line never has to say which
 * kind it carried.
 */
function traceFact(fact: ShellTraceFact): string {
  if (fact === null) return 'none'
  if (typeof fact !== 'object') return String(fact)
  if ('bottom' in fact) return `${fact.x},${fact.bottom}`
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
  /** Where the closed rail hangs on the display it is docked to (see #90). */
  bounds: ScreenRect
}

/**
 * Pure options builder, split from createMainWindow so the creation-time
 * contract — the stored pin preference lands in `alwaysOnTop`, the frameless
 * floating-panel flags stay fixed, the window opens as the closed rail — is
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
     * including the columns the fold (#388) had left exactly where they were
     * (#394). Electron documents `false` as removing "window shadow and window
     * animations" and edge-drag resizing: the window is not resizable, and the
     * shell paints its own shadow, so nothing this app relies on goes with it.
     * Windows-only by definition; the other platforms ignore it.
     */
    thickFrame: false,
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
       * for it, and it is set on THIS window only: the message panel's
       * window plays nothing, so it keeps the default.
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
  return { ...layout }
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
 * the rail toggle and the mine-open resize both do — neither is the Settings
 * position control, and neither may nudge the docked side as a side effect.
 * Only a request that names one (the position control) ever moves it.
 */
export function setPanelLayout(request: PanelLayoutRequest): PanelLayout {
  layout = {
    edge: request.edge ?? layout.edge,
    expanded: request.expanded,
    mineOpen: request.mineOpen
  }
  if (mainWindow !== null) {
    const area = currentScreenArea()
    // Re-scaled as well as re-sized: a layout change can move the window onto
    // another display, and the zoom belongs to the display rather than to the
    // window that happens to be on it.
    applyUiScale(mainWindow.webContents, area)
    applyPanelBounds(mainWindow, panelBounds(area, layout.edge, layout))
    // The panel stands beside the shell, so a shell that moved or changed
    // width moved the free edge the panel is placed against (#162) — and a
    // layout change can carry the pair onto another display, which is the
    // other half of why the scale is re-applied above.
    placeMessagePanel()
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
      preloadPath: join(import.meta.dirname, '../preload/index.mjs'),
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
   * Re-clamp the message panel when the displays change under it (#296).
   *
   * A docked panel is re-derived on every show, every layout change and every
   * height report, so it never needed this. A panel the person MOVED is
   * different in kind: its rectangle is a position they chose, and nothing
   * they do afterwards has to touch it — so a monitor unplugged, a resolution
   * change or a taskbar appearing can leave it off screen with no gesture
   * involved and nothing to correct it. `placeMessagePanel` is the one path
   * (see its own comment); it does nothing when there is no panel window, and
   * for a docked one it re-derives exactly what it already had.
   *
   * Registered here rather than beside the panel window because this runs
   * once: the panel window is created on the first open and hidden rather than
   * destroyed after, so subscribing over there would risk one listener per
   * rebuild for a rectangle main can always re-derive from state it holds.
   */
  const refitMessagePanel = (): void => placeMessagePanel()
  screen.on('display-metrics-changed', refitMessagePanel)
  screen.on('display-added', refitMessagePanel)
  screen.on('display-removed', refitMessagePanel)

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return mainWindow
}

export function showPanel(): void {
  if (!mainWindow) return
  // Re-derived on every show: a docked panel that was hidden across a
  // resolution change, a docking event or a display being unplugged would
  // otherwise come back sized for a screen that is no longer there — and, since
  // #153, scaled for one too.
  const area = currentScreenArea()
  applyUiScale(mainWindow.webContents, area)
  applyPanelBounds(mainWindow, panelBounds(area, layout.edge, layout))
  mainWindow.show()
  // Shown is not RAISED (#165): the same frameless-transparent window that a
  // click does not bring forward can also come back underneath whatever had the
  // foreground while it was hidden. One rule, one function, both entry points.
  raisePanelWindow(mainWindow)
  // The panel comes back with the shell, and only if a surface was open when
  // the pair went away (#162): the tray toggle and the global shortcut mean
  // the app's surfaces, not the shell alone, and a panel left behind would
  // float over other programs with nothing beside it.
  if (messagePanel.surface !== 'none' && messagePanelWindow !== null) {
    placeMessagePanel()
    messagePanelWindow.show()
  }
}

export function hidePanel(): void {
  mainWindow?.hide()
  // A drag cannot survive the window going away (#296): the press that would
  // have ended it lands on nothing once there is nothing on screen to release.
  endMessagePanelDrag()
  // Neither can a pending reveal (#312). The surface stays open across a trip
  // to the tray — that is what brings the panel back with the shell — so a
  // wait left running would show the panel on its own over other programs.
  cancelMessagePanelReveal()
  // Hidden WITH the shell, not closed: what the panel is showing is untouched,
  // so the surface that comes back is the one that went away.
  if (messagePanelWindow !== null && !messagePanelWindow.isDestroyed()) {
    messagePanelWindow.hide()
  }
}

export function togglePanel(): void {
  if (!mainWindow) return
  if (mainWindow.isVisible()) {
    hidePanel()
  } else {
    showPanel()
  }
}
/**
 * The height the panel window is CREATED at, before the renderer has measured
 * anything: the design's own base export (`assets/messages/message-panel.png`
 * is 235px tall).
 *
 * Deliberately not a second copy of the renderer's sizing rules, which own the
 * real number — the floor, the ceiling, the ask's raised floor and the mapping
 * from a message to a height all live in `lib/message/panelHeight.ts`. This is
 * only what the window is while it is still HIDDEN: `setMessagePanelHeight`
 * replaces it with the measured height, and that first report is what reveals
 * the window, so nobody ever sees a panel at this size.
 */
const MESSAGE_PANEL_OPENING_HEIGHT = 235

/**
 * How the panel window's page is told which surface it is (#162). One renderer
 * entry serves both windows; see RendererSurface for why that beats a second
 * build target.
 */
const MESSAGE_PANEL_SURFACE_QUERY = `${RENDERER_SURFACE_PARAM}=${MESSAGE_PANEL_SURFACE}`

/**
 * How long main waits for the created window's first height report before
 * revealing it anyway (#312).
 *
 * The window is created hidden and a height report is the ONE thing that
 * reveals it, so a renderer that does not report costs the click entirely —
 * which is what the first open of a run did: the report was suppressed while
 * the surface still had nothing in it, and the ResizeObserver that would have
 * caught the panel mounting cannot fire in a window whose frames are not being
 * drawn (see MessagePanelWindow.vue, which is where the reporting was fixed).
 * That fix is the answer; this is the floor under it, because "the panel never
 * appeared" must not be reachable from any renderer at all.
 *
 * A second is chosen from both ends: longer than the page load and the first
 * poll the report races, so on an ordinary open this never fires, and short
 * enough that what a person sees is the panel opening rather than a click that
 * did nothing. A late report re-places the window this revealed, at the height
 * it should have had.
 */
export const MESSAGE_PANEL_REVEAL_TIMEOUT_MS = 1000

/**
 * How long main holds the window open after its surface closed, waiting to be
 * told the surface has settled (#389).
 *
 * The mirror of the wait above. That one is the floor under a renderer that
 * never MEASURES; this is the floor under one that never REPORTS — a page that
 * crashed, or one whose leave was left un-run by something nobody has thought
 * of. Neither is main's to diagnose, and both must end with the window gone.
 *
 * 350ms is the renderer's own `PANEL_LEAVE_BOUND_MS` (#266), stated here rather
 * than imported: the deadlines behind a Web Animation are renderer facts, and a
 * main process importing them from `renderer/src/lib` would be this file
 * depending on how the shell animates. What has to hold is only the ORDER — the
 * renderer bounds its leave with a watchdog at 300ms and reports, so on any
 * honest close the report arrives first and this never fires.
 */
export const MESSAGE_PANEL_LEAVE_TIMEOUT_MS = 350

let messagePanelWindow: BrowserWindow | null = null
/** The wait above, while one is running. */
let messagePanelRevealTimer: NodeJS.Timeout | null = null
/** The deferred hide, while a closed surface is still settling (#389). */
let messagePanelHideTimer: NodeJS.Timeout | null = null
/** What the panel window is showing — see MessagePanelState; main owns it. */
let messagePanel: MessagePanelState = emptyMessagePanel()
/** The panel's own height in DESIGN pixels, as its renderer last measured it. */
let messagePanelDesignHeight = MESSAGE_PANEL_OPENING_HEIGHT

/**
 * Where the person put the panel, or `null` while it is still docked (#296).
 *
 * Docked until moved: the panel opens beside the shell, as the design's mock
 * draws it, and only a drag on its header ever sets this. Once it is set the
 * shell stops being what the panel is placed against — see
 * `messagePanelPlacement`, which is where that decision is stated and tested.
 */
let messagePanelAnchor: MessagePanelAnchor | null = null

/**
 * A header drag in progress: where the cursor was when it started, where the
 * window was, and the clock main follows the cursor on.
 *
 * Both origins are the ones from the START of the gesture rather than a
 * running total, so a drag that pushed the window against a screen edge comes
 * back off it when the cursor does — accumulating clamped deltas would leave
 * the window stuck there.
 */
let messagePanelDrag: {
  cursor: { x: number; y: number }
  origin: ScreenRect
  clock: NodeJS.Timeout
} | null = null

/**
 * How often main re-reads the cursor while the header is held down — one
 * frame at 60Hz.
 *
 * Main drives this rather than the renderer for the reason
 * `MessagePanelDragPhase` gives: a window tracking the cursor stops seeing the
 * cursor move, so a renderer reporting each step would stall the drag it was
 * driving.
 */
const MESSAGE_PANEL_DRAG_INTERVAL_MS = 16

export interface MessagePanelWindowOptionsInput {
  /** The shell's pin, mirrored rather than owned (see below). */
  alwaysOnTop: boolean
  preloadPath: string
  iconPath: string
  bounds: ScreenRect
  /** The shell window, which this one is a child of. */
  parent: BrowserWindow
}

/**
 * Pure options builder for the message panel's own window (#162), split from
 * its creation for the reason `buildMainWindowOptions` is: the creation-time
 * contract is the whole of what this window's relationship to the shell is,
 * and it is assertable without an Electron runtime.
 *
 * ## Three decisions live here
 *
 * **It is a CHILD of the shell.** Closing the shell closes it, which is the
 * lifecycle the issue asks for and one Electron gives for free rather than one
 * this file has to remember. `skipTaskbar` on top of that, because the panel
 * must never appear as a second application beside the app it belongs to — the
 * shell already does not.
 *
 * **It mirrors the shell's pin; it does not own one.** Pinning is a Settings
 * control and a property of the app's stacking (#35). A panel that floated
 * above other windows while the shell did not — or the reverse — would split
 * one question into two answers, and the user has one switch for it.
 *
 * **It is not resizable.** The design's vertical-only resize is the panel's own
 * top-edge handle: the renderer reports the height it arrived at and main
 * applies it, so the width can never be dragged away from the 990 the whole
 * composition is derived from. `resizable: false` is what makes "vertically
 * only" true of the window rather than merely intended by the component.
 *
 * Created hidden, like the shell: nothing has measured the panel at the moment
 * it is built, and the first height report is what reveals it.
 */
export function buildMessagePanelWindowOptions(
  input: MessagePanelWindowOptionsInput
): BrowserWindowConstructorOptions {
  return {
    ...input.bounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    // For the reason the shell drops it (#394): every height report is a
    // `setBounds`, and a thick frame animates each one across the whole panel.
    thickFrame: false,
    skipTaskbar: true,
    parent: input.parent,
    // Stated for the same reason the shell states it (#165): a frameless
    // transparent window that Electron was told not to focus cannot be typed
    // into, and this one is a composer.
    focusable: true,
    alwaysOnTop: input.alwaysOnTop,
    icon: input.iconPath,
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  }
}

/** What the panel window is showing (#162) — read, never requested. */
export function messagePanelState(): MessagePanelState {
  return { ...messagePanel }
}

/**
 * Adopt a persisted position before any window exists (#296) — index.ts calls
 * this with the stored one right after loading it, mirroring how the edge
 * preference reaches `seedPanelEdge`. A panel the person had moved then opens
 * where they left it instead of docking beside the shell and jumping.
 */
export function seedMessagePanelPosition(anchor: MessagePanelAnchor | null): void {
  messagePanelAnchor = anchor
}

/**
 * The screen rectangle the panel may cover: the display its own remembered
 * position is on once it has been moved, and the shell's until then (#296).
 *
 * Two displays are two different questions, and a panel carried onto the
 * second one has to be clamped and scaled for THAT one — `uiScale`'s own rule
 * is that the zoom belongs to the display rather than to the window that
 * happens to be on it, and clamping a detached panel to the shell's display
 * would drag it back off the monitor the person chose.
 *
 * The anchor's own point rather than the window's bounds, because this is also
 * what answers the question before the window is built (and while a display it
 * used to be on is gone). `getDisplayNearestPoint` always names a display, so
 * an anchor pointing at a monitor that was unplugged resolves against a real
 * one and then fails the reach test in `detachedMessagePanelBounds` — which is
 * exactly the fall-back-to-docked path.
 */
function messagePanelScreenArea(): ScreenRect {
  if (messagePanelAnchor === null) return currentScreenArea()
  const display = screen.getDisplayNearestPoint({
    x: messagePanelAnchor.x,
    y: messagePanelAnchor.bottom
  })
  return panelScreenArea(display, currentPlatform())
}

/**
 * Drop a remembered position that no longer lands on any display (#296).
 *
 * The monitor it was dragged onto was unplugged, or the resolution shrank
 * under it. Forgotten rather than carried, so the fallback to the docked
 * placement is derived against the SHELL's display — a stale anchor left in
 * place would have every later apply compute the docked rectangle against a
 * display the shell is not on. The stored file is not rewritten here: the next
 * drag or snap-back replaces it, and until then re-reading a position that
 * fails this same test costs nothing.
 */
function forgetLostMessagePanelPosition(): void {
  if (messagePanelAnchor === null) return
  const lost =
    detachedMessagePanelBounds(
      messagePanelScreenArea(),
      messagePanelAnchor,
      messagePanelDesignHeight
    ) === null
  if (lost) messagePanelAnchor = null
}

/**
 * Where the panel window belongs right now: where the person put it, or beside
 * the shell as the shell ACTUALLY is, at the height its renderer last measured.
 *
 * The shell's real bounds rather than a re-derivation, so a compositor that
 * placed the shell somewhere else moves the panel with it instead of leaving
 * the pair apart. With no shell window yet there is nothing to be beside, so
 * the rectangle main would have given it stands in. Which of the two answers
 * applies is `messagePanelPlacement`'s decision, not this function's.
 */
function messagePanelRect(): ScreenRect {
  const area = messagePanelScreenArea()
  const shell =
    mainWindow === null ? panelBounds(area, layout.edge, layout) : mainWindow.getBounds()
  return messagePanelPlacement(
    area,
    shell,
    layout.edge,
    messagePanelDesignHeight,
    messagePanelAnchor
  )
}

/**
 * Re-place and re-scale the panel window, if there is one.
 *
 * Both, for the reason `setPanelLayout` does both: the zoom belongs to the
 * DISPLAY rather than to the window that happens to be on it, and the panel
 * shares the shell's ui scale exactly — the same 1080-design-world factor,
 * applied to a second window so the two surfaces are one size.
 *
 * Still called from all four places it was (#296), and that is not an
 * oversight: a detached panel is re-placed to the rectangle it is already at,
 * because the placement is derived from the remembered position rather than
 * from the shell. So a shell move or a layout change moves nothing, a height
 * report resizes it in place, and a display that changed under it is
 * re-clamped — one path, three behaviours, none of them a special case.
 */
function placeMessagePanel(): void {
  if (messagePanelWindow === null || messagePanelWindow.isDestroyed()) return
  forgetLostMessagePanelPosition()
  applyUiScale(messagePanelWindow.webContents, messagePanelScreenArea())
  applyPanelBounds(messagePanelWindow, messagePanelRect())
}

/**
 * The slice of BrowserWindow the reveal below needs. Narrow for the reason the
 * four targets above are: the whole of the decision is assertable with a fake,
 * and the wait it hangs off cannot be reached from a unit test at all.
 */
export interface MessagePanelRevealTarget {
  isDestroyed: () => boolean
  isVisible: () => boolean
}

/**
 * Whether to show a panel window that no height report ever arrived for (#312).
 *
 * Three refusals, and each is a state the wait can end in rather than an
 * unlikely one: the report landed inside the window and already revealed it, so
 * showing it again would be a raise nobody asked for; the surface closed while
 * the wait ran, and the panel would come back on a dwarf nobody has selected
 * any more; or the window is gone.
 */
export function messagePanelNeedsReveal(
  target: MessagePanelRevealTarget,
  surface: MessagePanelSurface
): boolean {
  if (target.isDestroyed()) return false
  if (surface === 'none') return false
  return !target.isVisible()
}

/** End the wait for a height report — it arrived, or what it was for is gone. */
function cancelMessagePanelReveal(): void {
  if (messagePanelRevealTimer === null) return
  clearTimeout(messagePanelRevealTimer)
  messagePanelRevealTimer = null
}

/** Start it again, from now: one wait per open, never two. */
function armMessagePanelReveal(): void {
  cancelMessagePanelReveal()
  messagePanelRevealTimer = setTimeout(
    revealMessagePanelWithoutReport,
    MESSAGE_PANEL_REVEAL_TIMEOUT_MS
  )
}

/**
 * The wait ran out: place and show the panel at whatever height it is, which
 * is MESSAGE_PANEL_OPENING_HEIGHT unless some earlier report set one.
 *
 * Placed first rather than merely shown, because a display may have been
 * unplugged or rescaled while this waited — the same re-clamp every other
 * apply does.
 */
function revealMessagePanelWithoutReport(): void {
  messagePanelRevealTimer = null
  const panel = messagePanelWindow
  if (panel === null || !messagePanelNeedsReveal(panel, messagePanel.surface)) return
  placeMessagePanel()
  panel.show()
  if (shellDebugEnabled()) {
    // The line that says the panel on screen was never measured (#312): a run
    // printing this is a renderer that reported nothing, not a geometry
    // problem, and the designHeight names what it was revealed at.
    console.log(
      formatShellTrace('message panel revealed without a height report', {
        designHeight: messagePanelDesignHeight,
        surface: messagePanel.surface,
        bounds: panel.getBounds()
      })
    )
  }
}

/**
 * The same two questions `MessagePanelRevealTarget` asks, for the opposite
 * decision — a window on its way out rather than one on its way in.
 */
export type MessagePanelHideTarget = MessagePanelRevealTarget

/**
 * Whether a settled surface should take its window with it (#389).
 *
 * Three refusals, and like the reveal's each is a state the wait genuinely ends
 * in rather than an unlikely one: nothing deferred this hide, so the report is
 * a leave nobody was waiting for — a stale one from a close that was overtaken,
 * or a renderer reporting twice; the surface opened again while the old one was
 * settling, and hiding now would close a panel somebody has just asked for; or
 * the window is already gone, or was never shown.
 *
 * `waiting` is the whole of what makes this safe against a reopen. Main cancels
 * the wait when a surface opens, so a report that arrives afterwards finds
 * nothing armed and changes nothing.
 */
export function messagePanelHideIsDue(
  target: MessagePanelHideTarget,
  surface: MessagePanelSurface,
  waiting: boolean
): boolean {
  if (!waiting) return false
  if (surface !== 'none') return false
  if (target.isDestroyed()) return false
  return target.isVisible()
}

/** End the wait for a settle report — it arrived, or the surface opened again. */
function cancelMessagePanelHide(): void {
  if (messagePanelHideTimer === null) return
  clearTimeout(messagePanelHideTimer)
  messagePanelHideTimer = null
}

/** Hide the window now, if the rules above still say the hide is owed. */
function hideMessagePanelIfDue(): void {
  const waiting = messagePanelHideTimer !== null
  cancelMessagePanelHide()
  const panel = messagePanelWindow
  if (panel === null) return
  if (!messagePanelHideIsDue(panel, messagePanel.surface, waiting)) return
  panel.hide()
}

/**
 * The surface has closed: hold the window open while it settles, rather than
 * taking it off screen in the frame the state changed (#389).
 *
 * A window that is not on screen has nothing to settle and nothing to wait for,
 * which is every close of a panel whose renderer never reported a height, and
 * every close arriving before the window was built.
 */
function deferMessagePanelHide(): void {
  cancelMessagePanelHide()
  const panel = messagePanelWindow
  if (panel === null || panel.isDestroyed()) return
  if (!panel.isVisible()) return
  messagePanelHideTimer = setTimeout(hideMessagePanelIfDue, MESSAGE_PANEL_LEAVE_TIMEOUT_MS)
}

/**
 * The panel renderer reporting that its surface has finished leaving (#389) —
 * the whole of what the deferred hide above is waiting for.
 */
export function messagePanelSurfaceSettled(): void {
  hideMessagePanelIfDue()
}

/** Stop following the cursor; the gesture is over, or its window has gone. */
function endMessagePanelDrag(): void {
  if (messagePanelDrag === null) return
  clearInterval(messagePanelDrag.clock)
  messagePanelDrag = null
}

/**
 * One step of a header drag: put the window where the cursor has taken it.
 *
 * The work area is the display the CURSOR is nearest rather than the one the
 * window is mostly on, which is what lets a drag cross monitors at all: a
 * clamp against the window's own display would keep it inside that display, so
 * it could never reach the half-way point where the display it is "on" changes.
 *
 * A press that has not moved the cursor at all is left alone, so a plain click
 * on the header — and the double-click that snaps the panel back — never
 * detaches the panel from the shell.
 */
function stepMessagePanelDrag(): void {
  const drag = messagePanelDrag
  if (drag === null) return
  if (messagePanelWindow === null || messagePanelWindow.isDestroyed()) {
    endMessagePanelDrag()
    return
  }
  const cursor = screen.getCursorScreenPoint()
  const dx = cursor.x - drag.cursor.x
  const dy = cursor.y - drag.cursor.y
  if (dx === 0 && dy === 0) return
  const area = panelScreenArea(screen.getDisplayNearestPoint(cursor), currentPlatform())
  // The live size, not the size the gesture started at: the panel may have
  // re-measured itself mid-drag, and the width and height are never the
  // drag's to change.
  const { width, height } = messagePanelWindow.getBounds()
  const moved = applyPanelBounds(
    messagePanelWindow,
    clampMessagePanelBounds(area, {
      x: drag.origin.x + dx,
      y: drag.origin.y + dy,
      width,
      height
    })
  )
  // What the window ACTUALLY became, never the request: the compositor may
  // have placed it elsewhere, and a remembered position that disagrees with
  // the window would move the panel on its next apply.
  messagePanelAnchor = messagePanelAnchorOf(moved)
}

/**
 * Begin or end a drag of the panel window by its header (#296), and answer
 * with the position main now remembers.
 *
 * The answer is for the caller to PERSIST, not to render: nothing on either
 * page draws the panel's position, so a renderer holding a copy could only
 * ever disagree with the window. `null` is still docked — which is what a
 * press that never moved leaves behind.
 *
 * A 'start' clears any drag already running, which is also what recovers from
 * an 'end' that never arrived (a page that reloaded mid-gesture): the next
 * press on the header replaces the runaway, and its release ends it.
 */
export function dragMessagePanel(phase: MessagePanelDragPhase): MessagePanelAnchor | null {
  if (phase === 'end') {
    endMessagePanelDrag()
    // One re-place once the gesture is over, because a drag can cross onto
    // another display and the drag itself only moves the origin: the zoom
    // belongs to the display (see applyUiScale), and the design's 990 is
    // multiplied by that display's scale, so the panel adopts both here rather
    // than keeping the previous monitor's size until something else happens.
    placeMessagePanel()
    return messagePanelAnchor
  }
  endMessagePanelDrag()
  if (messagePanelWindow === null || messagePanelWindow.isDestroyed()) return messagePanelAnchor
  messagePanelDrag = {
    cursor: screen.getCursorScreenPoint(),
    origin: messagePanelWindow.getBounds(),
    clock: setInterval(stepMessagePanelDrag, MESSAGE_PANEL_DRAG_INTERVAL_MS)
  }
  return messagePanelAnchor
}

/**
 * Snap the panel back beside the shell and forget where it was (#296) — the
 * way back from a position that turned out to be the wrong one, and the one
 * gesture that clears a remembered position on purpose.
 *
 * Answers with the position main now remembers, which is `null`, for the same
 * reason `dragMessagePanel` answers: the caller persists it.
 */
export function dockMessagePanel(): MessagePanelAnchor | null {
  endMessagePanelDrag()
  messagePanelAnchor = null
  placeMessagePanel()
  return messagePanelAnchor
}

function createMessagePanelWindow(parent: BrowserWindow): BrowserWindow {
  // The persisted position may name a display that is no longer here (#296),
  // and this is the first apply of the session: dropping it now is what makes
  // the opening rectangle the docked one rather than a corner of a display the
  // panel was never on.
  const storedAnchor = messagePanelAnchor
  forgetLostMessagePanelPosition()
  const bounds = messagePanelRect()
  if (shellDebugEnabled()) {
    // The one open that takes this path is the first of the run (#312), so
    // this line is what says which rectangle it asked for, on which display,
    // and what became of a position read at startup — kept, or dropped here.
    console.log(
      formatShellTrace('message panel window created', {
        bounds,
        area: messagePanelScreenArea(),
        shell: parent.getBounds(),
        storedAnchor,
        anchor: messagePanelAnchor,
        designHeight: messagePanelDesignHeight
      })
    )
  }
  const panel = new BrowserWindow(
    buildMessagePanelWindowOptions({
      // Whatever the shell IS, not what the preference said: the user may have
      // unpinned since it opened.
      alwaysOnTop: parent.isAlwaysOnTop(),
      bounds,
      parent,
      preloadPath: join(import.meta.dirname, '../preload/index.mjs'),
      iconPath: resolveResourcePath('app-icon.png', {
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      })
    })
  )

  // The scale lands before the first paint, for the reason the shell's does
  // (#153): Electron resets a page's zoom on every navigation, the window is
  // created hidden, and a panel flashed at 1x on a 4K display is what setting
  // it any later would buy.
  panel.webContents.on('did-finish-load', () => {
    if (panel.isDestroyed()) return
    applyUiScale(panel.webContents, currentScreenArea())
  })

  // The panel closes to NOTHING rather than to a destroyed window: reopening
  // it on the next dwarf then costs no page load, and the surface it comes
  // back with is a fresh mount either way (the renderer keys it by dwarf).
  panel.on('close', (event) => {
    if (shellDebugEnabled()) {
      // A close here resets the state to 'none' and hides the window, which
      // from the outside is indistinguishable from an open that never happened
      // (#312) — so the line has to say that it fired at all, and whether it
      // was the quit or something else that closed it.
      console.log(
        formatShellTrace('message panel window close', {
          quitting,
          surface: messagePanel.surface,
          visible: panel.isVisible()
        })
      )
    }
    if (quitting) return
    event.preventDefault()
    setMessagePanel(emptyMessagePanel())
  })

  // Any external navigation opens in the default browser, never in the panel.
  panel.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const url = process.env.ELECTRON_RENDERER_URL
  if (url) {
    void panel.loadURL(`${url}?${MESSAGE_PANEL_SURFACE_QUERY}`)
  } else {
    void panel.loadFile(join(import.meta.dirname, '../renderer/index.html'), {
      search: MESSAGE_PANEL_SURFACE_QUERY
    })
  }

  return panel
}

/**
 * Apply a state one of the two windows asked for, and answer with what main
 * now holds (#162).
 *
 * Same read-back rule as `setPanelLayout`: the caller renders the fact rather
 * than the wish. What is applied here is the WINDOW — created on the first
 * open, re-placed on every later one, hidden when the surface closes. Hidden
 * rather than destroyed, so the panel that comes back is one page load old
 * instead of a new one.
 *
 * A state that arrives before the shell exists is stored and nothing else: the
 * panel is a child of a window that is not there yet, and the next open after
 * the shell is built places it.
 */
export function setMessagePanel(state: MessagePanelState): MessagePanelState {
  const opening = state.surface !== 'none'
  messagePanel = { ...state }
  // Every transition ends the previous wait, whichever way it goes: a close
  // has nothing left to reveal, and an open is a new race of its own (#312).
  cancelMessagePanelReveal()
  if (!opening) {
    // The height is a fact about a surface that has closed. Reopening measures
    // again — which is also the design's own rule, that a reopened panel
    // recalculates from the latest message.
    messagePanelDesignHeight = MESSAGE_PANEL_OPENING_HEIGHT
    // The POSITION is not: closing and reopening the panel brings it back
    // where the person left it (#296), which is the whole point of remembering
    // it. Only the drag itself ends here, with the window it was moving.
    endMessagePanelDrag()
    // Held open while the surface settles (#389), which is the one thing the
    // window has to still be on screen for. `messagePanelSurfaceSettled` is
    // what ends the wait early, and it almost always does.
    deferMessagePanelHide()
    return messagePanelState()
  }
  // An open inside that wait finds the window still up, which is the whole
  // point of it: nothing to reveal, and nothing left to hide.
  cancelMessagePanelHide()
  if (mainWindow === null) return messagePanelState()
  if (messagePanelWindow === null || messagePanelWindow.isDestroyed()) {
    messagePanelWindow = createMessagePanelWindow(mainWindow)
  } else {
    // Which of the two branches an open took is the whole question in #312:
    // the first one creates a window and every later one lands here, so a run
    // that works and a run that does not differ by exactly this line.
    if (shellDebugEnabled()) {
      console.log(
        formatShellTrace('message panel placed', {
          surface: messagePanel.surface,
          visible: messagePanelWindow.isVisible()
        })
      )
    }
    placeMessagePanel()
  }
  // Both branches, one rule (#312): whichever of them ran, the window is still
  // hidden and only a height report shows it. The report almost always wins
  // this race — and when it does not, the click still opens a panel.
  armMessagePanelReveal()
  return messagePanelState()
}

/**
 * Adopt the height the panel measured of itself, in design pixels, and reveal
 * the window if this is the first report since it opened (#162).
 *
 * The design's vertical-only resize crosses here: the height derives from the
 * latest message when the panel opens, a drag on its top edge changes it, and
 * the history tab opens it to the ceiling — all of that is the renderer's, and
 * this is the window catching up. Showing on the first report is what keeps
 * anybody from seeing the panel at a height nothing had measured.
 */
export function setMessagePanelHeight(designHeight: number): void {
  messagePanelDesignHeight = designHeight
  const debug = shellDebugEnabled()
  // Both refusals below are what a hidden window looks like from the outside
  // (#312), and each was a bare `return`: the report can arrive before the
  // window exists, or after the surface it measured has already closed.
  if (messagePanelWindow === null || messagePanelWindow.isDestroyed()) {
    if (debug) {
      console.log(
        formatShellTrace('message panel height refused', { designHeight, reason: 'no window' })
      )
    }
    return
  }
  if (messagePanel.surface === 'none') {
    if (debug) {
      console.log(
        formatShellTrace('message panel height refused', { designHeight, reason: 'surface none' })
      )
    }
    return
  }
  // The report this was waiting for (#312): it sizes the window and reveals it
  // below, so there is nothing left for the fallback to do.
  cancelMessagePanelReveal()
  const visibleBefore = messagePanelWindow.isVisible()
  placeMessagePanel()
  if (!messagePanelWindow.isVisible()) messagePanelWindow.show()
  if (debug) {
    // The report that reveals the window is the FIRST one, so `visibleBefore`
    // false with `visible` true is the moment the panel appeared — and the two
    // both false is the show having been asked for and refused.
    console.log(
      formatShellTrace('message panel height', {
        designHeight,
        surface: messagePanel.surface,
        visibleBefore,
        visible: messagePanelWindow.isVisible(),
        bounds: messagePanelWindow.getBounds()
      })
    )
  }
}

/** The panel window's page, for the one push main owes it. Null when there is none. */
export function messagePanelWebContents(): WebContents | null {
  if (messagePanelWindow === null || messagePanelWindow.isDestroyed()) return null
  return messagePanelWindow.webContents
}

/** The shell's page, for the pushes main owes it. Null before it exists. */
export function shellWebContents(): WebContents | null {
  if (mainWindow === null || mainWindow.webContents.isDestroyed()) return null
  return mainWindow.webContents
}

/**
 * Raise and focus whichever of the app's windows sent a click (#162, #165).
 *
 * The shell reports every press on itself because a frameless transparent
 * window is not reliably raised by the platform's own click-to-front; the
 * panel is the same kind of window and needs the same thing, so the channel
 * answers for the SENDER rather than always for the shell. A press on the
 * panel that raised the shell instead would leave the surface being typed into
 * exactly where it was.
 */
export function raiseWindowOf(contents: WebContents): void {
  const target = BrowserWindow.fromWebContents(contents)
  if (target !== null) raisePanelWindow(target)
}
/**
 * Mirror the shell's pin onto the panel window (#35, #162).
 *
 * Called with the state the SHELL actually ended up in, never the request:
 * one surface in two windows must not answer the stacking question two ways,
 * and Settings has one switch for it. A panel that does not exist yet adopts
 * the shell's state when it is built.
 */
export function mirrorMessagePanelPin(pinned: boolean): void {
  if (messagePanelWindow === null || messagePanelWindow.isDestroyed()) return
  messagePanelWindow.setAlwaysOnTop(pinned)
}
