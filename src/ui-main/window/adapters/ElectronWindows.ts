import type { BrowserWindowConstructorOptions } from 'electron'
import { t } from '@dwarfai/contracts'
import type { ModeWindowRegistry } from '../application/modeWindowRegistry'
import type { PanelWindowSurface } from '../application/panelWindow'
import type { AlwaysOnTopLevel, VetaWindowSurface } from '../application/VetaWindowController'
import type {
  DisplayKey,
  PanelWindow,
  Rect,
  ValleWindow,
  VetaWindow,
  WindowFactory
} from '../ports/windowFactory'
import { applyAlwaysOnTop, applyZoomFactor, raisePanelWindow } from './panelSurface'
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
 * The Veta window (ISSUE-285) loads the same entry with `?mode=veta`; it is built only when the composition asks for it,
 * which a build does only where Veta is in its built-modes list. The Valle window (ISSUE-299) loads it with
 * `?mode=valle`, likewise built only where Valle is in the build's built-modes list.
 */

/** Two crashes of one window closer than this are a repeat: no automatic reload (ADR-019 item 11). */
export const RENDERER_CRASH_WINDOW_MS = 60_000
/** A renderer unresponsive this long, with no `responsive` in between, is treated as a crash (ADR-019 item 11). */
export const RENDERER_HANG_MS = 30_000

/**
 * The "renderer crashed" message and its actions. The copy is a design item (ADR-019 open item, DG "renderer crashed";
 * design request DR-01), looked up in the copy dictionary: until it exists, each string is the marked placeholder,
 * never shipped text (AGENTS.md §8.1).
 */
export const RENDERER_CRASHED_MESSAGE = {
  key: 'copy-needed.renderer-crashed',
  message: t('rendererCrashed.message'),
  reload: t('rendererCrashed.reload'),
  dismiss: t('rendererCrashed.dismiss')
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
  /** The page finished loading: Electron reset its zoom (ISSUE-047). */
  on(event: 'did-finish-load', listener: () => void): unknown
  setZoomFactor(factor: number): void
  getZoomFactor(): number
  getZoomMode(): 'default' | 'isolated' | 'manual' | 'disabled'
  setZoomMode(mode: 'default' | 'isolated' | 'manual' | 'disabled'): void
}

/** The part of Electron's `BrowserWindow` the adapter drives, and what the Panel surface reads back (ISSUE-047). */
export interface ManagedBrowserWindow {
  readonly webContents: ManagedWebContents
  setBounds(bounds: Rect): void
  getBounds(): Rect
  showInactive(): void
  show(): void
  hide(): void
  focus(): void
  moveTop(): void
  restore(): void
  setAlwaysOnTop(flag: boolean, level?: AlwaysOnTopLevel): void
  /** Click-through (ADR-025 item 4): `forward` keeps mouse moves reaching the page while clicks pass through. */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
  isAlwaysOnTop(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  close(): void
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): unknown
  on(event: 'minimize' | 'restore', listener: () => void): unknown
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

export interface VetaWindowOptionsInput {
  preloadPath: string
  iconPath: string
}

/**
 * What the Veta window asks of the secure factory: the Veta row of ADR-025 item 1. Built hidden and placed by its
 * controller before it is first shown (the work area of its `displayKey`); its always-on-top level is set right after
 * creation, because a constructor option cannot name one (`VetaWindowController`).
 */
export function vetaWindowRequest(input: VetaWindowOptionsInput): SecureWindowRequest {
  return {
    preload: input.preloadPath,
    window: {
      show: false,
      frame: false,
      // The island's shape leaves transparent corners; they pass clicks through (ADR-025 item 4).
      transparent: true,
      // The strip paints its own shadow; macOS would draw a second one around the transparent window (#465).
      hasShadow: false,
      // Only UI main sizes it, before a rise and after a fold, never during a motion (ADR-025 item 2).
      resizable: false,
      // Windows keeps the DWM resize animation on a frameless window otherwise, flashing it on every `setBounds` (#394).
      thickFrame: false,
      skipTaskbar: true,
      // Stated, not left to the default: the strip takes keys for docking and its chats (#165).
      focusable: true,
      alwaysOnTop: true,
      icon: input.iconPath
    }
  }
}

/** The Veta window's constructor options, exactly as the secure factory builds them. */
export function buildVetaWindowOptions(
  input: VetaWindowOptionsInput
): BrowserWindowConstructorOptions {
  return secureWindowOptions(vetaWindowRequest(input))
}

/** What the Valle window's options are built from. */
export interface ValleWindowOptionsInput {
  preloadPath: string
  iconPath: string
}

/**
 * What the Valle window asks of the secure factory: the Valle row of ADR-025 item 1. Built hidden and placed by its
 * controller before it is first shown (the work area of the display matching the window it is entered from, 07 S39.01).
 * Not always on top, out of the taskbar (the Panel keeps the app's taskbar presence), and throttled while hidden
 * (ADR-025 item 7).
 */
export function valleWindowRequest(input: ValleWindowOptionsInput): SecureWindowRequest {
  return {
    preload: input.preloadPath,
    backgroundThrottling: true,
    window: {
      show: false,
      frame: false,
      alwaysOnTop: false,
      skipTaskbar: true,
      icon: input.iconPath
    }
  }
}

/** The Valle window's constructor options, exactly as the secure factory builds them. */
export function buildValleWindowOptions(
  input: ValleWindowOptionsInput
): BrowserWindowConstructorOptions {
  return secureWindowOptions(valleWindowRequest(input))
}

/** The app entry a mode window loads: the same bundle, with its mode in the query (ADR-025 item 1). */
export function modeEntry(appEntry: string, mode: 'veta' | 'valle'): string {
  const url = new URL(appEntry)
  url.searchParams.set('mode', mode)
  return url.toString()
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
  /** Where the Panel opens and whether it is pinned (`PanelWindowUseCases.panelStart`, ISSUE-047). */
  panelStart(): { alwaysOnTop: boolean; bounds: Rect }
  timers: RendererTimers
  /** Shows the "renderer crashed" message parented to `window` (`showRendererCrashedMessage` in production). */
  crashMessage(window: ManagedBrowserWindow): Promise<CrashChoice>
}

export class ElectronWindows implements WindowFactory {
  private panelWindow: { window: ManagedBrowserWindow; mode: PanelWindow } | null = null
  /** The zoom the Panel's page was last given, given back after every load (#153); `null` before the first fit. */
  private panelZoom: number | null = null
  private readonly panelMinimizeHandlers: Array<() => void> = []
  private vetaWindow: { window: ManagedBrowserWindow; mode: VetaWindow } | null = null
  private valleWindow: { window: ManagedBrowserWindow; mode: ValleWindow } | null = null

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
    const mode = this.manage(window, this.deps.appEntry)
    // Electron resets a page's zoom on every navigation, a crash reload included: the Panel's page gets back the zoom
    // it was last given as soon as it has loaded, before anyone sees it at 1x (#153).
    window.webContents.on('did-finish-load', () => {
      if (this.panelZoom !== null) applyZoomFactor(window.webContents, this.panelZoom)
    })
    const minimizeChanged = (): void => {
      for (const h of this.panelMinimizeHandlers) h()
    }
    window.on('minimize', minimizeChanged)
    window.on('restore', minimizeChanged)
    this.panelWindow = { window, mode }
    return mode
  }

  /**
   * The Panel window's read-backs for the Panel window use case (`PanelWindowSurface`, ISSUE-047): each member acts on
   * the Panel window `panel()` built, building it if there is none. Asking for the surface builds nothing.
   */
  panelSurface(): PanelWindowSurface {
    const window = (): ManagedBrowserWindow => {
      this.panel()
      return this.panelWindow!.window
    }
    return {
      applyZoom: (factor) => {
        this.panelZoom = factor
        return applyZoomFactor(window().webContents, factor)
      },
      bounds: () => window().getBounds(),
      setAlwaysOnTop: (on) => applyAlwaysOnTop(window(), on),
      isAlwaysOnTop: () => window().isAlwaysOnTop(),
      raise: () => raisePanelWindow(window()),
      isMinimized: () => window().isMinimized(),
      isVisible: () => {
        const built = this.panelWindow?.window
        return built !== undefined && !built.isDestroyed() && built.isVisible()
      },
      onMinimizedChanged: (h) => {
        this.panelMinimizeHandlers.push(h)
      }
    }
  }

  /**
   * The one Veta window (ADR-025 items 1, 5): the open one, or a new one when there is none. It is built on its first
   * use and then kept; on another display it is the same window, placed there by its controller. `displayKey` names
   * the display it opens on, which its controller reads for the placement (16 §4.14; INV-118).
   */
  veta(_displayKey: DisplayKey): VetaWindow {
    if (this.vetaWindow !== null && !this.vetaWindow.window.isDestroyed()) {
      return this.vetaWindow.mode
    }
    const window = createSecureWindow(
      this.deps.BrowserWindow,
      vetaWindowRequest({ preloadPath: this.deps.preload, iconPath: this.deps.icon })
    )
    this.vetaWindow = {
      window,
      // Built on its first entry, whose run is sent at once (S24.18, S27.05): its pushes wait for its page (VQA-08).
      mode: this.manage(window, modeEntry(this.deps.appEntry, 'veta'), { holdUntilLoaded: true })
    }
    return this.vetaWindow.mode
  }

  /** The `webContents` id of the Veta window, while it is open; `null` before it is built or once it closed. */
  vetaWebContentsId(): number | null {
    const built = this.vetaWindow?.window
    return built === undefined || built.isDestroyed() ? null : built.webContents.id
  }

  /**
   * The Veta window's own members beyond `ModeWindow` (`VetaWindowSurface`): each acts on the Veta window `veta()`
   * built. Asking for the surface builds nothing; using it before the window exists is a defect of its caller.
   */
  vetaSurface(): VetaWindowSurface {
    const window = (): ManagedBrowserWindow => {
      const built = this.vetaWindow?.window
      if (built === undefined || built.isDestroyed()) throw new Error('no Veta window is built')
      return built
    }
    return {
      setAlwaysOnTopLevel: (level) => window().setAlwaysOnTop(true, level),
      setIgnoreMouseEvents: (ignore) => window().setIgnoreMouseEvents(ignore, { forward: true }),
      bounds: () => window().getBounds()
    }
  }

  /**
   * The one Valle window (ADR-025 item 1; 07 machine 39): the open one, or a new one when there is none. Built on its
   * first use and then kept; `from` names the display it opens on, which its controller places it on (16 §4.14).
   */
  valle(_from: DisplayKey): ValleWindow {
    if (this.valleWindow !== null && !this.valleWindow.window.isDestroyed()) {
      return this.valleWindow.mode
    }
    const window = createSecureWindow(
      this.deps.BrowserWindow,
      valleWindowRequest({ preloadPath: this.deps.preload, iconPath: this.deps.icon })
    )
    this.valleWindow = {
      window,
      // Built on its first entry, whose run is sent at once (S39.01, S27.05): its pushes wait for its page (ISSUE-311).
      mode: this.manage(window, modeEntry(this.deps.appEntry, 'valle'), { holdUntilLoaded: true })
    }
    return this.valleWindow.mode
  }

  /** The `webContents` id of the Valle window, while it is open; `null` before it is built or once it closed. */
  valleWebContentsId(): number | null {
    const built = this.valleWindow?.window
    return built === undefined || built.isDestroyed() ? null : built.webContents.id
  }

  /**
   * Registers, watches and loads a new window from `entry`, and answers its `ModeWindow` members. With
   * `holdUntilLoaded`, a push sent before the page first loaded is held and sent, in order, once it has: a page that
   * has not run yet hears nothing (the Valle window's first run, ISSUE-311).
   */
  private manage(
    window: ManagedBrowserWindow,
    entry: string,
    options: { holdUntilLoaded?: boolean } = {}
  ): PanelWindow {
    const id = window.webContents.id
    this.deps.registry.register(id)
    window.once('closed', () => this.deps.registry.drop(id))
    watchRenderer(window, { ...this.deps, appEntry: entry })
    let held: [string, unknown][] | null = options.holdUntilLoaded === true ? [] : null
    if (held !== null) {
      window.webContents.on('did-finish-load', () => {
        const waiting = held ?? []
        held = null
        for (const [push, payload] of waiting) window.webContents.send(push, payload)
      })
    }
    void window.webContents.loadURL(entry)
    return {
      placeAt: (bounds) => window.setBounds(bounds),
      showInactive: () => window.showInactive(),
      hide: () => window.hide(),
      focus: () => window.focus(),
      send: (push, payload) => {
        if (held !== null) held.push([push, payload])
        else window.webContents.send(push, payload)
      }
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
