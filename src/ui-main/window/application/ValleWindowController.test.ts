// layer: L2
import { beforeEach, describe, expect, it } from 'vitest'
import { ElectronWindows, buildValleWindowOptions } from '../adapters/ElectronWindows'
import { FakeBrowserWindow } from '../adapters/fakes/FakeBrowserWindow'
import type { ValleEntry } from '../domain/valleWindow'
import { FakeScreenAreaProvider } from '../ports/fakes/FakeScreenAreaProvider'
import type { DisplayInfo } from '../ports/screenAreaProvider'
import { createModeWindowRegistry } from './modeWindowRegistry'
import { createValleWindowController } from './ValleWindowController'

/**
 * The Valle window (ADR-025 items 1, 7; 16 §4.14 `WindowFactory.valle`, `ScreenAreaProvider`; 07 machine 39): the real
 * `ElectronWindows` adapter over a fake Electron `BrowserWindow` and a `FakeScreenAreaProvider`.
 */
const APP_ENTRY = 'http://localhost:5173/'
const PRELOAD = '/app/out/preload/index.cjs'
const ICON = '/app/resources/app-icon.png'

const LEFT: DisplayInfo = {
  displayKey: 'DELL U2720Q|3840x2160|@2|0,0',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  primary: true
}
const RIGHT: DisplayInfo = {
  displayKey: 'LG HDR 4K|2560x1440|@1|1920,0',
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
  primary: false
}
const PANEL_ON_RIGHT = { x: 4060, y: 0, width: 420, height: 1400 }

function world() {
  const registry = createModeWindowRegistry()
  const windows = new ElectronWindows({
    BrowserWindow: FakeBrowserWindow,
    preload: PRELOAD,
    icon: ICON,
    appEntry: APP_ENTRY,
    registry,
    panelStart: () => ({ alwaysOnTop: false, bounds: PANEL_ON_RIGHT }),
    timers: { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined },
    crashMessage: () => Promise.resolve('dismiss')
  })
  const screen = new FakeScreenAreaProvider([LEFT, RIGHT])
  const controller = createValleWindowController({
    factory: windows,
    screen
  })
  return { controller, registry, screen, windows }
}

const valle = (): FakeBrowserWindow => {
  const built = FakeBrowserWindow.built
  expect(built).toHaveLength(1)
  return built[0]!
}

beforeEach(() => FakeBrowserWindow.reset())

describe('the Valle window (ADR-025 items 1, 7; ISSUE-299)', () => {
  it('[ADR-025, NFR-PLAT-13] the Valle window is created once by the secure factory, frameless, not always on top, out of the taskbar, and throttled while hidden', () => {
    const entry = { current: { from: 'window', bounds: PANEL_ON_RIGHT } as ValleEntry }
    const { controller, registry, windows } = world()
    expect(FakeBrowserWindow.built, 'nothing is built before the first use').toEqual([])
    expect(controller.built()).toBe(false)
    const first = controller.window()
    expect(controller.window()).toBe(first)
    const window = valle()
    expect(window.options).toEqual(
      buildValleWindowOptions({ preloadPath: PRELOAD, iconPath: ICON })
    )
    expect(window.options).toMatchObject({
      show: false,
      frame: false,
      alwaysOnTop: false,
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true
      }
    })
    expect(window.calls.some((c) => c.startsWith('setAlwaysOnTop'))).toBe(false)
    // Its own renderer of the same bundle, a registered mode window for the seam A sender check (ADR-019 item 8).
    expect(window.calls[0]).toBe(`loadURL ${APP_ENTRY}?mode=valle`)
    expect(registry.has(window.webContents.id)).toBe(true)
    expect(windows.valleWebContentsId()).toBe(window.webContents.id)
    // Placed on the work area of the display matching the window it is entered from, then hidden, never destroyed.
    first.placeAt(controller.bounds(entry.current))
    expect(window.getBounds()).toEqual(RIGHT.workArea)
    first.showInactive()
    first.hide()
    expect(window.isDestroyed()).toBe(false)
    expect(window.calls).not.toContain('close')
    expect(window.visible).toBe(false)
    expect(controller.state()).toBe('hidden')
  })

  it('[US-VALLE-001.AC10, S39.02] entered again from another display, Valle opens there, with no placement of its own', () => {
    const entry = { current: { from: 'window', bounds: PANEL_ON_RIGHT } as ValleEntry }
    const { controller } = world()
    const window = controller.window()
    window.placeAt(controller.bounds(entry.current))
    expect(valle().getBounds()).toEqual(RIGHT.workArea)
    window.showInactive()
    window.hide()
    entry.current = { from: 'window', bounds: { x: 700, y: 968, width: 480, height: 72 } }
    controller.window().placeAt(controller.bounds(entry.current))
    expect(valle().getBounds()).toEqual(LEFT.workArea)
  })

  it('[S39.08, S39.09] a display event re-places a shown Valle window, and a hidden one waits for its next entry', () => {
    const entry = { current: { from: 'window', bounds: PANEL_ON_RIGHT } as ValleEntry }
    const { controller, screen } = world()
    const window = controller.window()
    window.placeAt(controller.bounds(entry.current))
    window.showInactive()
    // S39.09: its display's work area shrank (a taskbar grew).
    const shorter: DisplayInfo = { ...RIGHT, workArea: { ...RIGHT.workArea, height: 1360 } }
    screen.set([LEFT, shorter])
    controller.displaysChanged()
    expect(valle().getBounds()).toEqual(shorter.workArea)
    // S39.08: its display unplugged: the display now matching its bounds, the primary.
    screen.set([LEFT])
    controller.displaysChanged()
    expect(valle().getBounds()).toEqual(LEFT.workArea)
    // Hidden, nothing moves until it is entered again.
    window.hide()
    const placed = valle().calls.filter((c) => c.startsWith('setBounds')).length
    screen.set([LEFT, RIGHT])
    controller.displaysChanged()
    expect(valle().calls.filter((c) => c.startsWith('setBounds'))).toHaveLength(placed)
  })
})
