// layer: L2
import { beforeEach, describe, expect, it } from 'vitest'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import { ElectronWindows, buildVetaWindowOptions } from '../adapters/ElectronWindows'
import { FakeBrowserWindow } from '../adapters/fakes/FakeBrowserWindow'
import type { WindowingPlatform, WindowingSession } from '../domain/windowingLimits'
import { FakeScreenAreaProvider } from '../ports/fakes/FakeScreenAreaProvider'
import type { DisplayInfo } from '../ports/screenAreaProvider'
import { createModeWindowRegistry } from './modeWindowRegistry'
import { createVetaWindowController } from './VetaWindowController'

/**
 * The Veta window (ADR-025 items 1, 4, 6; 16 §4.14 `WindowFactory.veta`, `ScreenAreaProvider.workArea`): the real
 * `ElectronWindows` adapter over a fake Electron `BrowserWindow` (the "fake Electron window factory") and a
 * `FakeScreenAreaProvider`, with the platform and the session passed in (17 §1.13), so the macOS and Linux cases run on
 * every host.
 */
const APP_ENTRY = 'http://localhost:5173/'
const PRELOAD = '/app/out/preload/index.cjs'
const ICON = '/app/resources/app-icon.png'

// Two displays whose keys are not their Electron ids: the Veta display is the second one listed and not the primary.
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
const ISLAND = { width: 480, height: 72 }

function world(
  options: { platform?: WindowingPlatform; session?: WindowingSession; displayKey?: string } = {}
) {
  const registry = createModeWindowRegistry()
  const windows = new ElectronWindows({
    BrowserWindow: FakeBrowserWindow,
    preload: PRELOAD,
    icon: ICON,
    appEntry: APP_ENTRY,
    registry,
    panelStart: () => ({ alwaysOnTop: false, bounds: LEFT.workArea }),
    timers: { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined },
    crashMessage: () => Promise.resolve('dismiss')
  })
  const log = new RecordingUiLog()
  const screen = new FakeScreenAreaProvider([LEFT, RIGHT])
  const controller = createVetaWindowController({
    factory: windows,
    surface: () => windows.vetaSurface(),
    screen,
    displayKey: () => options.displayKey ?? RIGHT.displayKey,
    island: () => ISLAND,
    platform: options.platform ?? 'win32',
    session: options.session ?? null,
    log
  })
  return { controller, registry, log, screen }
}

const veta = (): FakeBrowserWindow => {
  const built = FakeBrowserWindow.built
  expect(built).toHaveLength(1)
  return built[0]!
}

beforeEach(() => FakeBrowserWindow.reset())

describe('the Veta window (ADR-025 items 1, 4, 6; ISSUE-285)', () => {
  it('[ADR-025, NFR-PLAT-02] the Veta window is created once, lazily, by the secure factory with the options of the Veta row', () => {
    const { controller, registry } = world()
    expect(FakeBrowserWindow.built, 'nothing is built before the first use').toEqual([])
    const first = controller.window()
    expect(controller.window()).toBe(first)
    const window = veta()
    expect(window.options).toEqual(buildVetaWindowOptions({ preloadPath: PRELOAD, iconPath: ICON }))
    expect(window.options).toMatchObject({
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      focusable: true,
      alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    // Its own renderer of the same bundle, a registered mode window for the seam A sender check (ADR-019 item 8).
    expect(window.calls[0]).toBe(`loadURL ${APP_ENTRY}?mode=veta`)
    expect(registry.has(window.webContents.id)).toBe(true)
  })

  it('[ADR-025] the always-on-top level is screen-saver on macOS and pop-up-menu elsewhere', () => {
    const levels: Record<string, string> = {}
    for (const [platform, session] of [
      ['darwin', null],
      ['win32', null],
      ['linux', 'x11'],
      ['linux', 'xwayland']
    ] as const) {
      FakeBrowserWindow.reset()
      world({ platform, session }).controller.window()
      levels[`${platform} ${String(session)}`] = veta().calls.filter((c) =>
        c.startsWith('setAlwaysOnTop')
      )[0]!
    }
    expect(levels).toEqual({
      'darwin null': 'setAlwaysOnTop true screen-saver',
      'win32 null': 'setAlwaysOnTop true pop-up-menu',
      'linux x11': 'setAlwaysOnTop true pop-up-menu',
      'linux xwayland': 'setAlwaysOnTop true pop-up-menu'
    })
  })

  it('[NFR-PLAT-02, INV-118] its bounds come from the work area of its displayKey, never from display.id', () => {
    const { controller } = world()
    const bounds = controller.bounds()
    // Flush against the bottom of the RIGHT display's work area: inside it, the taskbar below it left uncovered.
    expect(bounds.width).toBe(ISLAND.width)
    expect(bounds.height).toBe(ISLAND.height)
    expect(bounds.y + bounds.height).toBe(RIGHT.workArea.y + RIGHT.workArea.height)
    expect(bounds.x).toBeGreaterThanOrEqual(RIGHT.workArea.x)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(RIGHT.workArea.x + RIGHT.workArea.width)
    controller.window().placeAt(bounds)
    expect(veta().getBounds()).toEqual(bounds)
  })

  it('[ADR-025] after its first use the window is hidden, never destroyed', () => {
    const { controller } = world()
    const window = controller.window()
    window.placeAt(controller.bounds())
    window.showInactive()
    window.hide()
    controller.window().showInactive()
    controller.window().hide()
    const built = veta()
    expect(built.isDestroyed()).toBe(false)
    expect(built.calls).not.toContain('close')
    expect(built.visible).toBe(false)
    expect(built.calls.filter((c) => c === 'hide')).toHaveLength(2)
  })

  it('[ADR-025] click-through on Windows and macOS sets setIgnoreMouseEvents with forward; on Linux it changes nothing', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      FakeBrowserWindow.reset()
      const { controller } = world({ platform })
      controller.window()
      controller.setClickThrough(true)
      controller.setClickThrough(false)
      expect(
        veta().calls.filter((c) => c.startsWith('setIgnoreMouseEvents')),
        platform
      ).toEqual([
        'setIgnoreMouseEvents true {"forward":true}',
        'setIgnoreMouseEvents false {"forward":true}'
      ])
    }
    FakeBrowserWindow.reset()
    const linux = world({ platform: 'linux', session: 'x11' })
    linux.controller.window()
    linux.controller.setClickThrough(true)
    expect(veta().calls.filter((c) => c.startsWith('setIgnoreMouseEvents'))).toEqual([])
    // A click-through before the window exists builds nothing.
    FakeBrowserWindow.reset()
    world().controller.setClickThrough(true)
    expect(FakeBrowserWindow.built).toEqual([])
  })

  it('[NFR-PLAT-05, FM-051] a getBounds mismatch after setBounds reports dockingAvailable false, logs veta.placement unplaced and shows the Settings notice once', () => {
    const { controller, log } = world({ platform: 'linux', session: 'wayland' })
    const noticed: boolean[] = []
    controller.onLimitsChanged((limits) => noticed.push(limits.dockingAvailable))
    expect(controller.limits()).toEqual({ dockingAvailable: false, alwaysOnTopAvailable: false })
    // A placement the compositor overrode on a session that names itself as X11: the read-back decides (ADR-025 item 6).
    const x11 = world({ platform: 'linux', session: 'x11' })
    x11.controller.onLimitsChanged((limits) => noticed.push(limits.dockingAvailable))
    expect(x11.controller.limits()).toEqual({ dockingAvailable: true, alwaysOnTopAvailable: true })
    const window = x11.controller.window()
    const built = FakeBrowserWindow.built.at(-1)!
    built.compositor = () => ({ x: 0, y: 0, width: 800, height: 600 })
    window.placeAt(x11.controller.bounds())
    window.placeAt(x11.controller.bounds())
    expect(x11.controller.limits()).toEqual({ dockingAvailable: false, alwaysOnTopAvailable: true })
    expect(x11.log.byEvent('veta.placement')).toEqual([
      {
        level: 'warn',
        event: 'veta.placement',
        subsystem: 'window',
        outcome: 'degraded',
        causeClass: 'unplaced'
      }
    ])
    // One change of the limits, so the one Settings › General notice reads them once.
    expect(noticed).toEqual([false])
    expect(log.byEvent('veta.placement')).toEqual([])
  })
})
