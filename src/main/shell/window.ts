import {
  BrowserWindow,
  app,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import type { MessagePanelState, PanelEdge, PanelLayout, PanelLayoutRequest } from '../domain/types'
import { MESSAGE_PANEL_SURFACE, RENDERER_SURFACE_PARAM } from '../domain/types'
import { currentPlatform } from '../platform/platform'
import { panelScreenArea, type ScreenRect } from '../platform/screenArea'
import { emptyMessagePanel } from './messagePanelState'
import { messagePanelBounds, panelBounds, uiScale } from './panelBounds'
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
      sandbox: false
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
  target.setZoomFactor(uiScale(area))
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

let messagePanelWindow: BrowserWindow | null = null
/** What the panel window is showing — see MessagePanelState; main owns it. */
let messagePanel: MessagePanelState = emptyMessagePanel()
/** The panel's own height in DESIGN pixels, as its renderer last measured it. */
let messagePanelDesignHeight = MESSAGE_PANEL_OPENING_HEIGHT

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
 * Where the panel window belongs right now: beside the shell as the shell
 * ACTUALLY is, at the height its renderer last measured.
 *
 * The shell's real bounds rather than a re-derivation, so a compositor that
 * placed the shell somewhere else moves the panel with it instead of leaving
 * the pair apart. With no shell window yet there is nothing to be beside, so
 * the rectangle main would have given it stands in.
 */
function messagePanelRect(): ScreenRect {
  const area = currentScreenArea()
  const shell =
    mainWindow === null ? panelBounds(area, layout.edge, layout) : mainWindow.getBounds()
  return messagePanelBounds(area, shell, layout.edge, messagePanelDesignHeight)
}

/**
 * Re-place and re-scale the panel window, if there is one.
 *
 * Both, for the reason `setPanelLayout` does both: the zoom belongs to the
 * DISPLAY rather than to the window that happens to be on it, and the panel
 * shares the shell's ui scale exactly — the same 1080-design-world factor,
 * applied to a second window so the two surfaces are one size.
 */
function placeMessagePanel(): void {
  if (messagePanelWindow === null || messagePanelWindow.isDestroyed()) return
  applyUiScale(messagePanelWindow.webContents, currentScreenArea())
  applyPanelBounds(messagePanelWindow, messagePanelRect())
}

function createMessagePanelWindow(parent: BrowserWindow): BrowserWindow {
  const panel = new BrowserWindow(
    buildMessagePanelWindowOptions({
      // Whatever the shell IS, not what the preference said: the user may have
      // unpinned since it opened.
      alwaysOnTop: parent.isAlwaysOnTop(),
      bounds: messagePanelRect(),
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
  if (!opening) {
    // The height is a fact about a surface that has closed. Reopening measures
    // again — which is also the design's own rule, that a reopened panel
    // recalculates from the latest message.
    messagePanelDesignHeight = MESSAGE_PANEL_OPENING_HEIGHT
    if (messagePanelWindow !== null && !messagePanelWindow.isDestroyed()) {
      messagePanelWindow.hide()
    }
    return messagePanelState()
  }
  if (mainWindow === null) return messagePanelState()
  if (messagePanelWindow === null || messagePanelWindow.isDestroyed()) {
    messagePanelWindow = createMessagePanelWindow(mainWindow)
  } else {
    placeMessagePanel()
  }
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
  if (messagePanelWindow === null || messagePanelWindow.isDestroyed()) return
  if (messagePanel.surface === 'none') return
  placeMessagePanel()
  if (!messagePanelWindow.isVisible()) messagePanelWindow.show()
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
