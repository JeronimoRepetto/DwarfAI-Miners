import { BrowserWindow, app, shell, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import { resolveResourcePath } from './resourcePaths'

let mainWindow: BrowserWindow | null = null
let quitting = false

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
}

/**
 * Pure options builder, split from createMainWindow so the creation-time
 * contract — the stored pin preference lands in `alwaysOnTop`, the frameless
 * floating-panel flags stay fixed — is testable without an Electron runtime.
 */
export function buildMainWindowOptions(
  input: MainWindowOptionsInput
): BrowserWindowConstructorOptions {
  return {
    width: 460,
    height: 600,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
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

export function createMainWindow(options: { alwaysOnTop: boolean }): BrowserWindow {
  mainWindow = new BrowserWindow(
    buildMainWindowOptions({
      alwaysOnTop: options.alwaysOnTop,
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
