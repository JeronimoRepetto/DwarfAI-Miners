import { BrowserWindow, app, screen, shell, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { PanelEdge, PanelLayout, PanelLayoutRequest } from '../domain/types'
import { currentPlatform } from '../platform/platform'
import { panelScreenArea, type ScreenRect } from '../platform/screenArea'
import { panelBounds } from './panelBounds'
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
    applyPanelBounds(mainWindow, panelBounds(currentScreenArea(), layout.edge, layout))
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
  // otherwise come back sized for a screen that is no longer there.
  applyPanelBounds(mainWindow, panelBounds(currentScreenArea(), layout.edge, layout))
  mainWindow.show()
  mainWindow.focus()
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
