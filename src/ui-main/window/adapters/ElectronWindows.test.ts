import type { BrowserWindow, dialog } from 'electron'
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { createModeWindowRegistry } from '../application/modeWindowRegistry'
import { runWindowFactoryContract } from '../ports/windowFactory.contract'
import {
  ElectronWindows,
  buildPanelWindowOptions,
  type CrashMessageDialog,
  type ElectronWindowsDeps,
  type ManagedBrowserWindow
} from './ElectronWindows'
import { FakeBrowserWindow } from './fakes/FakeBrowserWindow'
import { secureWindowOptions, type BrowserWindowClass } from './secureWindowOptions'

/*
 * TRANSPLANTED for ISSUE-046 from src/main/shell/window.test.ts (21 §6 row "Window and tray"; 05 §3.14 `ElectronWindows`
 * ← `shell/window.ts`, R). The legacy file was first run unchanged against this module (17 §2.5): all 43 cases failed,
 * because the rebuilt module removes the legacy module-level singletons (05 §3.14) and none of the legacy exports
 * exist here. Transplanted below, with their titles unchanged, are the cases whose subject this issue rebuilds: the
 * Panel window's creation options, now `buildPanelWindowOptions` over the secure factory (legacy
 * `buildMainWindowOptions`, same input). The others stay in src/main/shell/window.test.ts with their subject until it
 * is rebuilt: the pin read-back, the zoom, the bounds, the fit and its log line, the display refit and the layout edge
 * (the Panel window rows, later: ISSUE-047), the raise (`WindowRaiser`), and the legacy page load and its no-window
 * guard (the app entry is now the composition root's, and `panel()` loads it). Nothing is deleted there: the legacy
 * module leaves with ISSUE-058.
 */

/**
 * The Panel the redesigned shell opens as (#90) — a rectangle main derived from
 * the display before the window existed, which this file only has to carry
 * through untouched.
 */
const PANEL_BOUNDS = { x: 1402, y: 0, width: 518, height: 1032 }

describe('buildMainWindowOptions', () => {
  const input = {
    alwaysOnTop: true,
    preloadPath: 'C:/app/out/preload/index.cjs',
    iconPath: 'C:/app/resources/app-icon.png',
    bounds: PANEL_BOUNDS
  }

  it('applies the stored pin preference at creation', () => {
    expect(buildPanelWindowOptions({ ...input, alwaysOnTop: true }).alwaysOnTop).toBe(true)
    expect(buildPanelWindowOptions({ ...input, alwaysOnTop: false }).alwaysOnTop).toBe(false)
  })

  it('keeps the frameless floating-panel invariants regardless of the pin preference', () => {
    const options = buildPanelWindowOptions({ ...input, alwaysOnTop: false })
    expect(options.frame).toBe(false)
    expect(options.transparent).toBe(true)
    expect(options.skipTaskbar).toBe(true)
    expect(options.show).toBe(false)
  })

  it('drops the Windows thick frame, whose DWM animation is what flashed the whole shell on every resize (#394)', () => {
    // Windows-only by definition; the two things it costs are already gone
    // here — the window is not resizable and the shell paints its own shadow.
    expect(buildPanelWindowOptions(input).thickFrame).toBe(false)
  })

  it('paints no native shadow, because the shell paints its own (#465)', () => {
    expect(buildPanelWindowOptions(input).hasShadow).toBe(false)
    // Stated together: dropping the OS shadow must not cost the option that
    // stopped the Windows resize flash (#394), which removes the other one.
    expect(buildPanelWindowOptions(input).thickFrame).toBe(false)
  })

  it('wires the preload and icon paths through untouched', () => {
    const options = buildPanelWindowOptions(input)
    expect(options.webPreferences?.preload).toBe(input.preloadPath)
    expect(options.icon).toBe(input.iconPath)
  })

  it('keeps the renderer sandboxed from Node and isolated from the preload world', () => {
    const options = buildPanelWindowOptions(input)
    expect(options.webPreferences?.contextIsolation).toBe(true)
    expect(options.webPreferences?.nodeIntegration).toBe(false)
    // AMENDED for ISSUE-046 (ADR-019 item 1; was `sandbox: false` in the legacy window): the renderer is sandboxed.
    expect(options.webPreferences?.sandbox).toBe(true)
  })

  /*
   * The music has to start on its own (#174), and Chromium's autoplay policy
   * will not let it: a page that has had no user gesture cannot start audio,
   * and this window is created hidden and shown by a global shortcut or the
   * tray — neither of which is a gesture ON the page.
   */
  it('lets the renderer start audio without a user gesture, which #174 needs', () => {
    expect(buildPanelWindowOptions(input).webPreferences?.autoplayPolicy).toBe(
      'no-user-gesture-required'
    )
  })
})

describe('buildMainWindowOptions docked bounds', () => {
  const input = {
    alwaysOnTop: true,
    preloadPath: 'C:/app/out/preload/index.cjs',
    iconPath: 'C:/app/resources/app-icon.png',
    bounds: PANEL_BOUNDS
  }

  it('gives the docked panel no size for a user to drag', () => {
    const options = buildPanelWindowOptions(input)
    expect(options.resizable).toBe(false)
    // A floor would protect nothing: main is the only thing that sets these
    // bounds, and it derives them from what the Panel shows.
    expect(options.minWidth).toBeUndefined()
    expect(options.minHeight).toBeUndefined()
  })

  it('opens exactly on the rectangle it was handed', () => {
    const options = buildPanelWindowOptions(input)
    expect(options.x).toBe(PANEL_BOUNDS.x)
    expect(options.y).toBe(PANEL_BOUNDS.y)
    expect(options.width).toBe(PANEL_BOUNDS.width)
    expect(options.height).toBe(PANEL_BOUNDS.height)
  })

  it('never adjusts those bounds for the pin preference', () => {
    for (const alwaysOnTop of [true, false]) {
      const options = buildPanelWindowOptions({ ...input, alwaysOnTop })
      expect({ x: options.x, y: options.y, width: options.width, height: options.height }).toEqual(
        PANEL_BOUNDS
      )
    }
  })
})

describe('the shell window can be focused at all', () => {
  it('is focusable, stated rather than left to the default (#165)', () => {
    // The one flag that would silently undo the raise: a window Electron
    // was told not to focus cannot be focused by anything, click included.
    const options = buildPanelWindowOptions({
      alwaysOnTop: false,
      preloadPath: 'C:/app/out/preload/index.cjs',
      iconPath: 'C:/app/resources/app-icon.png',
      bounds: PANEL_BOUNDS
    })
    expect(options.focusable).toBe(true)
  })
})

// ---- the rebuilt adapter (ISSUE-046) ----

const APP_ENTRY = 'http://localhost:5173'

function deps(overrides: Partial<ElectronWindowsDeps> = {}): ElectronWindowsDeps {
  return {
    BrowserWindow: FakeBrowserWindow,
    preload: '/app/out/preload/index.cjs',
    icon: '/app/resources/app-icon.png',
    appEntry: APP_ENTRY,
    registry: createModeWindowRegistry(),
    panelStart: () => ({ alwaysOnTop: true, bounds: PANEL_BOUNDS }),
    timers: { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined },
    crashMessage: () => Promise.resolve('dismiss'),
    ...overrides
  }
}

beforeEach(() => FakeBrowserWindow.reset())

runWindowFactoryContract('ElectronWindows', () => new ElectronWindows(deps()))

describe('ElectronWindows (05 §3.14; ADR-019 items 1, 8)', () => {
  it('[ADR-019] the Panel window is built by the secure factory and loads the app entry', () => {
    new ElectronWindows(deps()).panel()
    const [window] = FakeBrowserWindow.built
    expect(FakeBrowserWindow.built).toHaveLength(1)
    expect(window?.options).toEqual(
      buildPanelWindowOptions({
        alwaysOnTop: true,
        preloadPath: '/app/out/preload/index.cjs',
        iconPath: '/app/resources/app-icon.png',
        bounds: PANEL_BOUNDS
      })
    )
    expect(window?.options.webPreferences).toEqual(
      secureWindowOptions({
        preload: '/app/out/preload/index.cjs',
        autoplayPolicy: 'no-user-gesture-required'
      }).webPreferences
    )
    expect(window?.calls).toEqual([`loadURL ${APP_ENTRY}`])
  })

  it('[ADR-019] the Panel window is a registered mode window from its creation until it closes', () => {
    const registry = createModeWindowRegistry()
    const windows = new ElectronWindows(deps({ registry }))
    windows.panel()
    const first = FakeBrowserWindow.built[0]!
    expect(registry.has(first.webContents.id)).toBe(true)
    first.close()
    expect(registry.has(first.webContents.id)).toBe(false)
    windows.panel()
    const second = FakeBrowserWindow.built[1]!
    expect(FakeBrowserWindow.built, 'a closed Panel is built again').toHaveLength(2)
    expect(registry.has(second.webContents.id)).toBe(true)
  })

  it('[ADR-019] the Panel window members drive that window', () => {
    const panel = new ElectronWindows(deps()).panel()
    panel.placeAt({ x: 1, y: 2, width: 3, height: 4 })
    panel.showInactive()
    panel.focus()
    panel.send('panel:visibility', false)
    panel.hide()
    expect(FakeBrowserWindow.built[0]?.calls).toEqual([
      `loadURL ${APP_ENTRY}`,
      'setBounds 3x4@1,2',
      'showInactive',
      'focus',
      'send panel:visibility false',
      'hide'
    ])
  })

  it('[ADR-019] Veta and Valle windows are not built yet and are refused, never improvised', () => {
    const windows = new ElectronWindows(deps())
    expect(() => windows.veta('display-a')).toThrow(/not built/)
    expect(() => windows.valle('display-a')).toThrow(/not built/)
    expect(FakeBrowserWindow.built).toEqual([])
  })

  it('[ADR-019] the Electron BrowserWindow class and dialog fit the adapter (checked by the typecheck)', () => {
    expectTypeOf<typeof BrowserWindow>().toMatchTypeOf<BrowserWindowClass<ManagedBrowserWindow>>()
    expectTypeOf<typeof dialog>().toMatchTypeOf<CrashMessageDialog<BrowserWindow>>()
  })
})

// ---- the Panel window surface (ISSUE-047) ----

describe('ElectronWindows Panel surface (05 §3.14; ADR-024 item 9; 13 FM-052)', () => {
  it('[ADR-019] asking for the Panel surface builds no window', () => {
    new ElectronWindows(deps()).panelSurface()
    expect(FakeBrowserWindow.built).toEqual([])
  })

  it('[FM-052] the Panel surface answers the always-on-top the window reads back, never the wish', () => {
    const windows = new ElectronWindows(deps())
    windows.panel()
    const surface = windows.panelSurface()
    const window = FakeBrowserWindow.built[0]!
    expect(surface.setAlwaysOnTop(false)).toBe(false)
    expect(window.pinned).toBe(false)
    window.honorsPin = false
    expect(surface.setAlwaysOnTop(true)).toBe(false)
    expect(surface.isAlwaysOnTop()).toBe(false)
  })

  it('[ADR-024] the Panel surface reads back the bounds and the zoom the window and its page really took', () => {
    const windows = new ElectronWindows(deps())
    const panel = windows.panel()
    windows.panel()
    const surface = windows.panelSurface()
    const window = FakeBrowserWindow.built[0]!
    window.widest = 600
    panel.placeAt({ x: 10, y: 0, width: 900, height: 1000 })
    expect(surface.bounds()).toEqual({ x: 10, y: 0, width: 600, height: 1000 })
    expect(surface.applyZoom(1.25)).toBe(1.25)
    expect(window.webContents.zoomMode).toBe('isolated')
    expect(FakeBrowserWindow.built, 'one Panel window').toHaveLength(1)
  })

  it('[US-SHELL-002.AC05] the Panel surface raises a visible Panel and never shows a hidden one', () => {
    const windows = new ElectronWindows(deps())
    windows.panel()
    const surface = windows.panelSurface()
    const window = FakeBrowserWindow.built[0]!
    surface.raise()
    expect(window.calls).not.toContain('moveTop')
    expect(window.calls).not.toContain('show')
    window.showInactive()
    window.minimized = true
    surface.raise()
    expect(window.calls.slice(-3)).toEqual(['restore', 'moveTop', 'focus'])
  })

  it('[ADR-024] the Panel surface reports a minimize and a restore of the Panel window', () => {
    const windows = new ElectronWindows(deps())
    windows.panel()
    const surface = windows.panelSurface()
    let changes = 0
    surface.onMinimizedChanged(() => changes++)
    const window = FakeBrowserWindow.built[0]!
    window.minimized = true
    window.emit('minimize')
    expect(surface.isMinimized()).toBe(true)
    window.minimized = false
    window.emit('restore')
    expect(changes).toBe(2)
  })

  it('[NFR-PLAT-12] a reloaded Panel page gets back the zoom it was last given', () => {
    const windows = new ElectronWindows(deps())
    windows.panel()
    const surface = windows.panelSurface()
    const window = FakeBrowserWindow.built[0]!
    // Loaded before any zoom was asked: nothing is applied.
    window.webContents.emit('did-finish-load')
    expect(window.webContents.zoom).toBe(1)
    surface.applyZoom(2)
    // Electron resets a page's zoom on every navigation (a crash reload included).
    window.webContents.zoom = 1
    window.webContents.emit('did-finish-load')
    expect(window.webContents.zoom).toBe(2)
  })
})

describe('the Panel visibility read-back (ISSUE-056; 16 §4.14 read-backs, visible)', () => {
  it('[US-SHELL-002.AC01] the surface reads the Panel window as it is, a closed one as not visible, and builds no window to answer', () => {
    const windows = new ElectronWindows(deps())
    const surface = windows.panelSurface()
    expect(surface.isVisible(), 'no Panel window yet').toBe(false)
    expect(FakeBrowserWindow.built).toHaveLength(0)

    windows.panel()
    const window = FakeBrowserWindow.built[0]!
    window.showInactive()
    expect(surface.isVisible()).toBe(true)

    window.close()
    expect(surface.isVisible(), 'a closed Panel').toBe(false)
    expect(FakeBrowserWindow.built, 'no window built to answer').toHaveLength(1)
  })
})
