import type { DisplayInfo, ScreenAreaProvider } from '../ports/screenAreaProvider'
import type { DisplayKey, Rect } from '../ports/windowFactory'

/**
 * `ElectronScreenArea`, the `ScreenAreaProvider` adapter of the window module (05 §3.14; 16 §4.14), adapted from the
 * legacy `platform/screenArea.ts` and `platform/windowMetrics.ts` (21 §6). This is where the window module's per-OS
 * story lives: which part of a display the Panel may cover, the narrowest window a platform makes, and the display
 * events (13 FM-111). Electron's `screen` is read when asked, never cached: a display's work area changes under the app
 * (a taskbar moved or auto-hidden, a scale change, a monitor unplugged).
 */

/** The three operating systems the app runs on (NFR-PLAT-01). */
export type UiPlatform = 'win32' | 'darwin' | 'linux'

/** The two rectangles Electron reports for one display. */
export interface DisplayAreas {
  /** The whole display. */
  bounds: Rect
  /** What is left once the OS reserved its own furniture. */
  workArea: Rect
}

/** The part of Electron's `Display` the adapter reads. */
export interface ElectronDisplay {
  readonly id: number
  readonly label: string
  readonly bounds: Rect
  readonly workArea: Rect
  /** In DIP; the native resolution is this times `scaleFactor`. */
  readonly size: { readonly width: number; readonly height: number }
  readonly scaleFactor: number
}

/** The part of Electron's `screen` the adapter reads and listens to. */
export interface ElectronScreen {
  getAllDisplays(): ElectronDisplay[]
  getPrimaryDisplay(): ElectronDisplay
  on(event: 'display-added', listener: () => void): unknown
  on(event: 'display-removed', listener: () => void): unknown
  on(event: 'display-metrics-changed', listener: () => void): unknown
}

/**
 * The stable key of a display (ADR-024 D5; INV-118): its label where it has one, its native resolution, its scale
 * factor and its place relative to the primary display. Never `display.id`, whose stability across reboots is
 * unverified (S-024-1). Two identical unlabelled monitors are still told apart by where they stand.
 */
export function displayKeyOf(display: ElectronDisplay, primary: ElectronDisplay): DisplayKey {
  const native = `${Math.round(display.size.width * display.scaleFactor)}x${Math.round(display.size.height * display.scaleFactor)}`
  const offset = `${display.bounds.x - primary.bounds.x},${display.bounds.y - primary.bounds.y}`
  return [display.label, native, `@${display.scaleFactor}`, offset].join('|')
}

/**
 * The rectangle the Panel may span on this display: `workArea`, on every platform (#238). It leaves the Windows
 * taskbar, the macOS Dock and menu bar, and a Linux top bar or dock visible; `platform` stays in the signature so a
 * future per-OS difference is made, and tested, here and nowhere else.
 */
export function panelScreenArea(display: DisplayAreas, _platform: UiPlatform): Rect {
  return display.workArea
}

/**
 * Windows, MEASURED (#153): a `BrowserWindow` asked for 20px comes back 32px wide. Asking for the floor makes a
 * left-docked window the same window as a right-docked one.
 */
const WIN32_MIN_WINDOW_WIDTH = 32

/**
 * macOS and Linux: UNMEASURED (#465). 20 is what these platforms were always asked for; a floor wider than the window
 * leaves a transparent gutter macOS draws its own shadow around. Settled on a Mac by creating a frameless transparent
 * window 20 wide and reading `getBounds().width` back.
 */
const UNMEASURED_MIN_WINDOW_WIDTH = 20

/** The narrowest window this platform actually makes, in real pixels (#465). */
export function minWindowWidth(platform: UiPlatform): number {
  return platform === 'win32' ? WIN32_MIN_WINDOW_WIDTH : UNMEASURED_MIN_WINDOW_WIDTH
}

export class ElectronScreenArea implements ScreenAreaProvider {
  /**
   * @param screen Electron's `screen`, asked for only when a display is read (it exists once the app is ready).
   * @param platform The OS this process runs on (`process.platform`, read by the composition root).
   */
  constructor(
    private readonly screen: () => ElectronScreen,
    private readonly platform: UiPlatform
  ) {}

  workArea(displayKey: DisplayKey): Rect {
    return this.find(displayKey).workArea
  }

  bounds(displayKey: DisplayKey): Rect {
    return this.find(displayKey).bounds
  }

  displays(): DisplayInfo[] {
    const screen = this.screen()
    const primary = screen.getPrimaryDisplay()
    const primaryKey = displayKeyOf(primary, primary)
    return screen.getAllDisplays().map((display) => {
      const displayKey = displayKeyOf(display, primary)
      return {
        displayKey,
        bounds: { ...display.bounds },
        workArea: { ...panelScreenArea(display, this.platform) },
        primary: displayKey === primaryKey
      }
    })
  }

  /** The narrowest window this platform makes, for the Panel's bounds (`PanelWindowDeps.floor`). */
  minWindowWidth(): number {
    return minWindowWidth(this.platform)
  }

  /** Calls `h` when a display is plugged in or out, or a display's work area or scale changes (13 FM-111). */
  onChange(h: () => void): void {
    const screen = this.screen()
    screen.on('display-added', () => h())
    screen.on('display-removed', () => h())
    screen.on('display-metrics-changed', () => h())
  }

  private find(displayKey: DisplayKey): DisplayInfo {
    const display = this.displays().find((d) => d.displayKey === displayKey)
    if (display === undefined) throw new Error(`ElectronScreenArea: no display ${displayKey}`)
    return display
  }
}

/** The OS this process runs on, one of the three the app runs on (NFR-PLAT-01); any other Unix is treated as Linux. */
export function currentUiPlatform(platform: NodeJS.Platform = process.platform): UiPlatform {
  return platform === 'win32' || platform === 'darwin' ? platform : 'linux'
}
