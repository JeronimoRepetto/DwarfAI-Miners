import type { BrowserWindowConstructorOptions } from 'electron'
import type { ModeWindowRegistry } from '../application/modeWindowRegistry'
import type {
  DisplayKey,
  PanelWindow,
  Rect,
  ValleWindow,
  VetaWindow,
  WindowFactory
} from '../ports/windowFactory'
import {
  createSecureWindow,
  secureWindowOptions,
  type BrowserWindowClass,
  type SecureWindowRequest
} from './secureWindowOptions'

/**
 * `ElectronWindows`, the `WindowFactory` adapter of the window module (05 §3.14; 16 §4.14), replacing the legacy
 * `src/main/shell/window.ts` (21 §6 row "Window and tray": replaced). Its state lives in the instance, never at module
 * scope. Every window it builds:
 *
 * - comes from the secure factory (`createSecureWindow`, ADR-019 item 1) and loads the app's own entry;
 * - is a registered mode window from its creation until it closes, so the seam A sender check knows it (ADR-019
 *   item 8);
 * - is watched by the renderer crash and hang policy (ADR-019 item 11; 13 FM-043, FM-044).
 *
 * Veta and Valle are not built yet (EPIC-19, EPIC-20): asking for one is refused, never improvised (hidden until built,
 * 21 §1 item 8).
 */

/** Two crashes of one window closer than this are a repeat: no automatic reload (ADR-019 item 11). */
export const RENDERER_CRASH_WINDOW_MS = 60_000
/** A renderer unresponsive this long, with no `responsive` in between, is treated as a crash (ADR-019 item 11). */
export const RENDERER_HANG_MS = 30_000

/**
 * The "renderer crashed" message and its actions. The copy is a design item (ADR-019 open item, DG "renderer crashed";
 * design request DR-01): until it exists, each string is the marked placeholder, never shipped text (AGENTS.md §8.1).
 */
export const RENDERER_CRASHED_MESSAGE = {
  key: 'copy-needed.renderer-crashed',
  message: '⟦COPY NEEDED: DG "renderer crashed"⟧',
  reload: '⟦COPY NEEDED: DG "renderer crashed" Reload⟧',
  dismiss: '⟦COPY NEEDED: DG "renderer crashed" dismiss⟧'
} as const

/** What the person chose on the "renderer crashed" message. */
export type CrashChoice = 'reload' | 'dismiss'

/** The clock and timers the crash and hang policy reads (a fake clock in tests). */
export interface RendererTimers {
  now(): number
  setTimeout(fire: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** The part of Electron's `WebContents` the adapter drives and listens to. */
export interface ManagedWebContents {
  readonly id: number
  loadURL(url: string): Promise<void>
  send(channel: string, payload: unknown): void
  forcefullyCrashRenderer(): void
  on(
    event: 'render-process-gone',
    listener: (event: unknown, details: { reason: string }) => void
  ): unknown
  on(event: 'unresponsive' | 'responsive', listener: () => void): unknown
}

/** The part of Electron's `BrowserWindow` the adapter drives. */
export interface ManagedBrowserWindow {
  readonly webContents: ManagedWebContents
  setBounds(bounds: Rect): void
  showInactive(): void
  hide(): void
  focus(): void
  close(): void
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): unknown
}

export interface PanelWindowOptionsInput {
  /** The persisted pin preference, applied from the very first frame (#35). */
  alwaysOnTop: boolean
  preloadPath: string
  iconPath: string
  /** Where the Panel hangs on the display it is docked to (#90). */
  bounds: Rect
}

/**
 * What the Panel window asks of the secure factory: the frameless, transparent, docked shell of today (legacy
 * `buildMainWindowOptions`, each flag kept with its reason). Its web preferences are the factory's (ADR-019 item 1).
 */
export function panelWindowRequest(input: PanelWindowOptionsInput): SecureWindowRequest {
  return {
    preload: input.preloadPath,
    window: {
      ...input.bounds,
      show: false,
      frame: false,
      transparent: true,
      // Docked (#90): main derives the rectangle, so there is no size for a person to drag.
      resizable: false,
      // Windows keeps the DWM resize animation on a frameless window otherwise, flashing the shell on every
      // `setBounds` (#394).
      thickFrame: false,
      // The shell paints its own shadow; macOS would draw a second one around the transparent window (#465).
      hasShadow: false,
      skipTaskbar: true,
      // Stated, not left to the default: a window that cannot take focus cannot be raised by a click (#165).
      focusable: true,
      alwaysOnTop: input.alwaysOnTop,
      icon: input.iconPath
    },
    // The music starts on its own and the window is shown by a shortcut or the tray, never a gesture on the page
    // (#174).
    autoplayPolicy: 'no-user-gesture-required'
  }
}

/** The Panel window's constructor options, exactly as the secure factory builds them. */
export function buildPanelWindowOptions(
  input: PanelWindowOptionsInput
): BrowserWindowConstructorOptions {
  return secureWindowOptions(panelWindowRequest(input))
}

export interface ElectronWindowsDeps {
  /** Electron's `BrowserWindow` class, handed only to the secure factory. */
  BrowserWindow: BrowserWindowClass<ManagedBrowserWindow>
  /** The preload: one CommonJS file (S-019-1). */
  preload: string
  icon: string
  /** The app's own entry every window loads and reloads (ADR-019 item 2). */
  appEntry: string
  /** The mode-window registry the seam A sender check reads (ADR-019 item 8; ISSUE-044). */
  registry: Pick<ModeWindowRegistry, 'register' | 'drop'>
  /** Where the Panel opens and whether it is pinned (the Panel window rows bind it, later: ISSUE-047). */
  panelStart(): { alwaysOnTop: boolean; bounds: Rect }
  timers: RendererTimers
  /** Shows the "renderer crashed" message parented to `window` (`showRendererCrashedMessage` in production). */
  crashMessage(window: ManagedBrowserWindow): Promise<CrashChoice>
}

export class ElectronWindows implements WindowFactory {
  private panelWindow: { window: ManagedBrowserWindow; mode: PanelWindow } | null = null

  constructor(private readonly deps: ElectronWindowsDeps) {}

  /** The one Panel window (INV-116): the open one, or a new one when there is none. */
  panel(): PanelWindow {
    if (this.panelWindow !== null && !this.panelWindow.window.isDestroyed()) {
      return this.panelWindow.mode
    }
    const start = this.deps.panelStart()
    const window = createSecureWindow(
      this.deps.BrowserWindow,
      panelWindowRequest({
        alwaysOnTop: start.alwaysOnTop,
        preloadPath: this.deps.preload,
        iconPath: this.deps.icon,
        bounds: start.bounds
      })
    )
    const mode = this.manage(window)
    this.panelWindow = { window, mode }
    return mode
  }

  veta(_displayKey: DisplayKey): VetaWindow {
    throw new Error('the Veta window is not built yet (EPIC-19)')
  }

  valle(_from: DisplayKey): ValleWindow {
    throw new Error('the Valle window is not built yet (EPIC-20)')
  }

  /** Registers, watches and loads a new window, and answers its `ModeWindow` members. */
  private manage(window: ManagedBrowserWindow): PanelWindow {
    const id = window.webContents.id
    this.deps.registry.register(id)
    window.once('closed', () => this.deps.registry.drop(id))
    watchRenderer(window, this.deps)
    void window.webContents.loadURL(this.deps.appEntry)
    return {
      placeAt: (bounds) => window.setBounds(bounds),
      showInactive: () => window.showInactive(),
      hide: () => window.hide(),
      focus: () => window.focus(),
      send: (push, payload) => window.webContents.send(push, payload)
    }
  }
}

/**
 * The renderer crash and hang policy of one window (ADR-019 item 11; 13 FM-043, FM-044). Electron main owns it, so it
 * works with no renderer at all.
 *
 * - A first crash (any `render-process-gone` reason but `clean-exit`) reloads the window once, in place, from the app
 *   entry. The UI-main session store lives in Electron main beside the window and the window is never closed for a
 *   crash, so the reloaded page finds its drafts and chat view state again (ADR-024 D3).
 * - A crash less than 60 s after the previous one shows one message with Reload and does not reload. Reload reloads in
 *   place and restarts the 60 s count from that moment; dismissing the message closes the window. While the message
 *   is open, a further crash shows no second one.
 * - `unresponsive` for 30 s with no `responsive` ends the renderer process, which is then handled as a crash.
 *
 * Nothing is sent to the Host: sessions are untouched.
 */
function watchRenderer(
  window: ManagedBrowserWindow,
  deps: Pick<ElectronWindowsDeps, 'appEntry' | 'timers' | 'crashMessage'>
): void {
  const { timers } = deps
  let lastCrashAt: number | null = null
  let messageOpen = false
  let hang: unknown = null
  const reload = (): void => {
    void window.webContents.loadURL(deps.appEntry)
  }
  const cancelHang = (): void => {
    if (hang === null) return
    timers.clearTimeout(hang)
    hang = null
  }

  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    cancelHang()
    if (messageOpen) return
    const now = timers.now()
    if (lastCrashAt === null || now - lastCrashAt >= RENDERER_CRASH_WINDOW_MS) {
      lastCrashAt = now
      reload()
      return
    }
    messageOpen = true
    void deps.crashMessage(window).then((choice) => {
      messageOpen = false
      if (window.isDestroyed()) return
      if (choice === 'reload') {
        lastCrashAt = timers.now()
        reload()
      } else {
        window.close()
      }
    })
  })
  window.webContents.on('unresponsive', () => {
    if (hang !== null) return
    hang = timers.setTimeout(() => {
      hang = null
      window.webContents.forcefullyCrashRenderer()
    }, RENDERER_HANG_MS)
  })
  window.webContents.on('responsive', cancelHang)
}

/** The part of Electron's `dialog` the crash message uses. */
export interface CrashMessageDialog<W> {
  showMessageBox(
    parent: W,
    options: {
      type: 'warning'
      message: string
      buttons: string[]
      defaultId: number
      cancelId: number
      noLink: boolean
    }
  ): Promise<{ response: number }>
}

/**
 * The "renderer crashed" message as a native message box parented to its window: no renderer is needed to draw it
 * (ADR-019 item 11). Its first button is Reload; anything else (the second button, Escape, closing the box) dismisses.
 */
export async function showRendererCrashedMessage<W>(
  dialog: CrashMessageDialog<W>,
  parent: W
): Promise<CrashChoice> {
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    message: RENDERER_CRASHED_MESSAGE.message,
    buttons: [RENDERER_CRASHED_MESSAGE.reload, RENDERER_CRASHED_MESSAGE.dismiss],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  return response === 0 ? 'reload' : 'dismiss'
}
