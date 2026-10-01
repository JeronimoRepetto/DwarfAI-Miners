// layer: L2
import { describe, expect, it } from 'vitest'
import { panelBounds, uiScale } from '../domain/panelBounds'
import { FakeScreenAreaProvider } from '../ports/fakes/FakeScreenAreaProvider'
import { FakeWindowFactory } from '../ports/fakes/FakeWindowFactory'
import {
  createInMemoryUiPreferenceStorage,
  InMemoryUiPreferenceStore,
  type InMemoryUiPreferenceStorage
} from '../ports/fakes/InMemoryUiPreferenceStore'
import type { DisplayInfo } from '../ports/screenAreaProvider'
import type { Rect } from '../ports/windowFactory'
import {
  createPanelWindow,
  fitPanelWindow,
  PANEL_VISIBILITY_PUSH,
  type PanelWindowSurface
} from './panelWindow'

/**
 * The rebuilt Panel window (05 §3.14 `PanelWindowController`; 16 §4.14; ADR-024 items 1, 9; 07 S10.08, S10.09;
 * 13 FM-052, FM-111) over `FakeWindowFactory`, `FakeScreenAreaProvider` and `InMemoryUiPreferenceStore`.
 */

const PRIMARY: DisplayInfo = {
  displayKey: 'primary',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  primary: true
}
const SECOND: DisplayInfo = {
  displayKey: 'second',
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1920, y: 0, width: 2560, height: 1392 },
  primary: false
}

/**
 * The Panel window's read-backs over the fake factory's Panel: the bounds the window manager left (a window may be
 * held narrower than asked, `widest`), the zoom the page took, the always-on-top state the OS granted (`honorsPin`),
 * whether it is minimized, and the raises asked of it.
 */
class FakePanelSurface implements PanelWindowSurface {
  zoom = 1
  pinned = false
  honorsPin = true
  minimized = false
  widest = Infinity
  readonly raises: number[] = []
  private readonly minimizeHandlers: Array<() => void> = []

  constructor(private readonly windows: FakeWindowFactory) {}

  applyZoom(factor: number): number {
    this.zoom = factor
    return this.zoom
  }

  bounds(): Rect {
    const placed = this.windows.panel().bounds ?? { x: 0, y: 0, width: 0, height: 0 }
    return { ...placed, width: Math.min(placed.width, this.widest) }
  }

  setAlwaysOnTop(on: boolean): boolean {
    if (this.honorsPin) this.pinned = on
    return this.pinned
  }

  isAlwaysOnTop(): boolean {
    return this.pinned
  }

  raise(): void {
    this.raises.push(this.raises.length + 1)
  }

  isMinimized(): boolean {
    return this.minimized
  }

  // AMENDED for ISSUE-056 (was: absent): the visibility read-back of the 2026-10-01 amendment; a window the fake never
  // built is not visible, and asking builds none.
  isVisible(): boolean {
    return this.windows.built.length > 0 && this.windows.panel().visible
  }

  onMinimizedChanged(h: () => void): void {
    this.minimizeHandlers.push(h)
  }

  /** The person minimized or restored the window. */
  setMinimized(minimized: boolean): void {
    this.minimized = minimized
    for (const h of this.minimizeHandlers) h()
  }
}

function subject(
  options: { storage?: InMemoryUiPreferenceStorage; displays?: DisplayInfo[] } = {}
) {
  const storage = options.storage ?? createInMemoryUiPreferenceStorage()
  const windows = new FakeWindowFactory()
  const surface = new FakePanelSurface(windows)
  const screen = new FakeScreenAreaProvider(options.displays ?? [PRIMARY])
  const displayHandlers: Array<() => void> = []
  const panel = createPanelWindow({
    windows,
    surface,
    screen,
    store: new InMemoryUiPreferenceStore(storage),
    floor: 32,
    onDisplaysChanged: (h) => displayHandlers.push(h)
  })
  const window = () => windows.panel()
  const displayChanged = () => {
    for (const h of displayHandlers) h()
  }
  return { panel, windows, surface, screen, storage, window, displayChanged }
}

/** The A-P1 pushes the Panel window was sent, in order. */
function visibilityPushes(window: { pushes: { push: string; payload: unknown }[] }): unknown[] {
  return window.pushes.filter((p) => p.push === PANEL_VISIBILITY_PUSH).map((p) => p.payload)
}

describe('the Panel window (PanelWindowController, 16 §4.14)', () => {
  it('[US-SHELL-002.AC01, S10.08] hidePanel hides the window and pushes onPanelVisibility false', () => {
    const { panel, window } = subject()
    panel.show()
    expect(window().visible).toBe(true)
    panel.hide()
    expect(window().visible).toBe(false)
    expect(panel.visible()).toBe(false)
    expect(visibilityPushes(window())).toEqual([true, false])
    expect(PANEL_VISIBILITY_PUSH).toBe('panel:visible:changed')
  })

  it('[US-SHELL-002.AC02, S10.09] showing a hidden Panel restores the page and mine it was left on', () => {
    const { panel, windows, window } = subject()
    panel.show()
    panel.setLayout({ mineOpen: true, dockOpen: false })
    const left = window().bounds
    panel.hide()
    panel.show()
    // The same window, never rebuilt or reloaded: the page and the mine it shows are the renderer's, kept as left.
    expect(windows.built).toEqual([{ kind: 'panel' }])
    expect(panel.layout()).toEqual({ edge: 'right', mineOpen: true, dockOpen: false })
    expect(window().bounds).toEqual(left)
    expect(window().pushes.map((p) => p.push)).toEqual([
      PANEL_VISIBILITY_PUSH,
      PANEL_VISIBILITY_PUSH,
      PANEL_VISIBILITY_PUSH
    ])
  })

  it('[US-SHELL-002.AC03] a hidden Panel has no visible window on any display', () => {
    const { panel, windows, window } = subject({ displays: [PRIMARY, SECOND] })
    panel.show()
    panel.hide()
    expect(windows.built).toEqual([{ kind: 'panel' }])
    expect(window().visible).toBe(false)
    expect(panel.visible()).toBe(false)
  })

  it('[US-SHELL-002.AC04, US-SET-011.AC02] the About "Hide panel" path calls the same hide as the app mark', () => {
    // The app mark and About's "Hide panel" both send A-01 `hidePanel`, which is `hide()`; the global shortcut's press
    // on a shown Panel is `toggleVisible()`. Each hides the window the same way, with the same push.
    const appMark = subject()
    appMark.panel.show()
    appMark.panel.hide()
    const shortcut = subject()
    shortcut.panel.show()
    shortcut.panel.toggleVisible()
    expect(shortcut.window().calls).toEqual(appMark.window().calls)
    // The hide, then the A-P1 push that follows it.
    expect(appMark.window().calls.slice(-2)).toEqual([
      { member: 'hide' },
      { member: 'send', push: PANEL_VISIBILITY_PUSH, payload: false }
    ])
    expect(visibilityPushes(shortcut.window())).toEqual(visibilityPushes(appMark.window()))
  })

  it('[US-SHELL-002.AC05] only the shortcut, the tray and a shown app mark can show a hidden Panel', () => {
    const { panel, window, surface, displayChanged } = subject()
    panel.show()
    panel.hide()
    const raisesWhileShown = surface.raises.length
    // Every other row of the Panel, and a display change, leaves it hidden.
    panel.raise()
    panel.setAlwaysOnTop(true)
    panel.alwaysOnTop()
    panel.setLayout({ mineOpen: true, dockOpen: true, edge: 'left' })
    panel.layout()
    panel.visible()
    displayChanged()
    expect(window().visible).toBe(false)
    expect(panel.visible()).toBe(false)
    expect(surface.raises).toHaveLength(raisesWhileShown)
    expect(window().calls.filter((c) => c.member === 'showInactive')).toHaveLength(1)
    // The shortcut and the tray show it (`toggleVisible`, `show`).
    panel.toggleVisible()
    expect(window().visible).toBe(true)
  })

  it('[US-SET-002.AC05] setAlwaysOnTop(false) answers false and the window leaves the top level', () => {
    const storage = createInMemoryUiPreferenceStorage()
    storage.stored.alwaysOnTop = true
    const { panel, surface } = subject({ storage })
    panel.show()
    expect(panel.setAlwaysOnTop(true)).toBe(true)
    expect(panel.setAlwaysOnTop(false)).toBe(false)
    expect(surface.pinned).toBe(false)
    expect(panel.alwaysOnTop()).toBe(false)
    expect(storage.stored.alwaysOnTop).toBe(false)
  })

  it('[US-SET-002.AC08] setPanelLayout with the other edge re-docks the window at once and answers the real layout', () => {
    const { panel, window, storage } = subject()
    panel.show()
    const answer = panel.setLayout({ mineOpen: false, dockOpen: false, edge: 'left' })
    expect(answer).toEqual({ edge: 'left', mineOpen: false, dockOpen: false })
    expect(window().bounds?.x).toBe(PRIMARY.workArea.x)
    expect(window().bounds).toEqual(
      panelBounds(PRIMARY.workArea, 'left', answer, 32, uiScale(PRIMARY.workArea))
    )
    expect(storage.stored.dockSide).toBe('left')
  })

  it('[FM-111] a display change re-docks the Panel on the current work area', () => {
    const { panel, window, screen, displayChanged } = subject({ displays: [PRIMARY] })
    panel.show()
    // The taskbar moved: the work area of the display the Panel is on changed under it.
    const taller = { ...PRIMARY, workArea: { x: 0, y: 48, width: 1920, height: 1032 } }
    screen.set([taller])
    displayChanged()
    expect(window().bounds).toEqual(
      panelBounds(taller.workArea, 'right', { mineOpen: false, dockOpen: false }, 32)
    )
    // The display the Panel was on was unplugged: it re-docks on the display left.
    const alone = { ...SECOND, primary: true }
    screen.set([alone])
    displayChanged()
    const bounds = window().bounds!
    expect(bounds.x + bounds.width).toBe(alone.workArea.x + alone.workArea.width)
    expect(bounds.height).toBe(alone.workArea.height)
  })

  it('[FM-111] a display change before the Panel was ever built builds no window', () => {
    const { windows, displayChanged } = subject()
    displayChanged()
    expect(windows.built).toEqual([])
  })

  it('[FM-052] an always-on-top the OS refuses is answered and stored as the real state', () => {
    const { panel, surface, storage } = subject()
    panel.show()
    surface.honorsPin = false
    expect(panel.setAlwaysOnTop(true)).toBe(false)
    expect(panel.alwaysOnTop()).toBe(false)
    expect(storage.stored.alwaysOnTop).toBe(false)
  })

  it('[ADR-024] a minimized Panel is not visible, and A-P1 follows it', () => {
    const { panel, window, surface } = subject()
    panel.show()
    surface.setMinimized(true)
    expect(panel.visible()).toBe(false)
    surface.setMinimized(false)
    expect(panel.visible()).toBe(true)
    expect(visibilityPushes(window())).toEqual([true, false, true])
  })

  it('[ADR-024] the Panel opens on the stored edge and pin, at its docked bounds, before anything is asked of it', () => {
    const storage = createInMemoryUiPreferenceStorage()
    storage.stored.dockSide = 'left'
    storage.stored.alwaysOnTop = true
    const { panel } = subject({ storage })
    expect(panel.panelStart()).toEqual({
      alwaysOnTop: true,
      bounds: panelBounds(PRIMARY.workArea, 'left', { mineOpen: false, dockOpen: false }, 32)
    })
    expect(panel.alwaysOnTop()).toBe(true)
  })

  it('[US-SHELL-002.AC05] raisePanel raises a shown Panel and never a hidden one', () => {
    const { panel, surface } = subject()
    panel.raise()
    expect(surface.raises).toEqual([])
    panel.show()
    const afterShow = surface.raises.length
    panel.raise()
    expect(surface.raises).toHaveLength(afterShow + 1)
  })
})

/*
 * TRANSPLANTED for ISSUE-047 from src/main/shell/window.test.ts (05 §3.14 `ElectronWindows` ← `shell/window.ts`;
 * 21 §6: replaced). Run unchanged first against this module (17 §2.5), the legacy file cannot pass here: it drives the
 * legacy module-level singletons (`seedPanelEdge`, `panelLayout`, `setPanelLayout`, `fitShellWindow` over a
 * BrowserWindow slice), which the rebuilt use case does not have (05 §3.14). Below, each case keeps its title and its
 * expectation; what changed is how it reaches the subject: the persisted edge is seeded through the `dockSide` store
 * (ADR-024 item 1) instead of `seedPanelEdge`, the fit is `fitPanelWindow` over the Panel window's `placeAt` and its
 * read-backs, and the display refit is the use case's own display handler. The legacy file is untouched; it leaves
 * with ISSUE-058.
 */
describe('fitShellWindow', () => {
  const area = { x: 0, y: 0, width: 2560, height: 1392 }
  const layout = { edge: 'right' as const, mineOpen: true, dockOpen: false }
  const WIN32_FLOOR = 32

  function fakeShell(options: { widest?: number } = {}) {
    let real = { x: 0, y: 0, width: 0, height: 0 }
    const asked: number[] = []
    let zoom = 1
    return {
      asked,
      target: {
        placeAt: (bounds: { x: number; y: number; width: number; height: number }) => {
          asked.push(bounds.width)
          real = { ...bounds, width: Math.min(bounds.width, options.widest ?? Infinity) }
        },
        bounds: () => real,
        applyZoom: (factor: number) => {
          zoom = factor
          return zoom
        }
      }
    }
  }

  it('holds the whole layout in a window that took the width it was asked', () => {
    const { target } = fakeShell()
    const fit = fitPanelWindow(target, area, layout, WIN32_FLOOR)
    expect(fit.held).toEqual({ mineOpen: true, dockOpen: false })
    expect(fit.appliedWidth).toBe(fit.requestedWidth)
    expect(fit.zoom).toBe(uiScale(area))
  })

  it('reports the page alone, sized for it, when the window refused to grow for the mine', () => {
    const { target, asked } = fakeShell({ widest: 668 })
    const fit = fitPanelWindow(target, area, layout, WIN32_FLOOR)
    expect(fit.held).toEqual({ mineOpen: false, dockOpen: false })
    expect(fit.requestedWidth).toBe(1062)
    // Asked again for the layout it holds, so the docked edge stays where the design puts it.
    expect(asked).toEqual([1062, 668])
    expect(fit.appliedWidth).toBe(668)
  })
})

describe('refitOnDisplayChange', () => {
  it('refits the shell, which holds every panel the app draws', () => {
    const { panel, window, displayChanged } = subject()
    panel.show()
    const placed = window().calls.filter((c) => c.member === 'placeAt').length
    displayChanged()
    expect(window().calls.filter((c) => c.member === 'placeAt')).toHaveLength(placed + 1)
  })
})

describe('panel layout edge (#138)', () => {
  function seeded(edge: 'left' | 'right') {
    const storage = createInMemoryUiPreferenceStorage()
    storage.stored.dockSide = edge
    return subject({ storage }).panel
  }

  it('seeds the persisted edge before any window exists, for the very first frame', () => {
    expect(seeded('left').layout().edge).toBe('left')
    expect(seeded('right').layout().edge).toBe('right')
  })

  it('keeps the current edge when a request does not name one', () => {
    const panel = seeded('left')
    expect(panel.setLayout({ mineOpen: true, dockOpen: false }).edge).toBe('left')
    expect(panel.setLayout({ mineOpen: false, dockOpen: true }).edge).toBe('left')
  })

  it('moves to the requested edge when the position control asks for one', () => {
    const panel = seeded('right')
    const result = panel.setLayout({ mineOpen: false, dockOpen: false, edge: 'left' })
    expect(result.edge).toBe('left')
    expect(panel.layout().edge).toBe('left')
  })

  it('carries mineOpen and dockOpen through unchanged alongside an edge move', () => {
    const panel = seeded('right')
    const result = panel.setLayout({ mineOpen: true, dockOpen: true, edge: 'left' })
    expect(result).toEqual({ edge: 'left', mineOpen: true, dockOpen: true })
  })

  it('starts as the Panel with nothing beside its page, before anything is asked of it', () => {
    expect(subject().panel.layout()).toEqual({ edge: 'right', mineOpen: false, dockOpen: false })
  })
})

describe('the Panel window at the start of UI main (ISSUE-056; 21 §2 cut 0)', () => {
  it('[ADR-001] load builds the Panel window hidden, its page loading, as today’s start did, and changes no preference', () => {
    const { panel, windows, storage } = subject()
    expect(windows.built).toEqual([])

    panel.load()

    expect(windows.built).toEqual([{ kind: 'panel' }])
    expect(windows.panel().visible).toBe(false)
    expect(panel.visible()).toBe(false)
    expect(visibilityPushes(windows.panel())).toEqual([])
    expect(storage.stored).toEqual({})
    // A second load builds no second Panel (INV-116).
    panel.load()
    expect(windows.built).toEqual([{ kind: 'panel' }])
  })
})

describe('the Panel window built by a factory that asks where it opens (ISSUE-056)', () => {
  it('[ADR-001] building the Panel asks panelStart once, on the display the screen names, with no read-back of a window that does not exist yet', () => {
    // As ElectronWindows does: the factory asks `panelStart` while it builds the window, and every read-back of the
    // surface acts on the window the factory built, building it if there is none.
    const storage = createInMemoryUiPreferenceStorage()
    const built = new FakeWindowFactory()
    let use: ReturnType<typeof createPanelWindow> | null = null
    let starts = 0
    const windows = {
      panel: () => {
        if (built.built.length === 0) {
          starts += 1
          if (starts > 1) throw new Error('panelStart asked again while the Panel was being built')
          const start = use?.panelStart()
          built.panel().placeAt(start?.bounds ?? { x: 0, y: 0, width: 0, height: 0 })
        }
        return built.panel()
      },
      veta: (key: string) => built.veta(key),
      valle: (from: string) => built.valle(from)
    }
    const surface = new FakePanelSurface(built)
    const readBack: PanelWindowSurface = {
      ...surface,
      applyZoom: (factor) => (windows.panel(), surface.applyZoom(factor)),
      bounds: () => (windows.panel(), surface.bounds()),
      setAlwaysOnTop: (on) => (windows.panel(), surface.setAlwaysOnTop(on)),
      isAlwaysOnTop: () => (windows.panel(), surface.isAlwaysOnTop()),
      raise: () => (windows.panel(), surface.raise()),
      isMinimized: () => (windows.panel(), surface.isMinimized()),
      isVisible: () => surface.isVisible(),
      onMinimizedChanged: (h) => surface.onMinimizedChanged(h)
    }
    use = createPanelWindow({
      windows,
      surface: readBack,
      screen: new FakeScreenAreaProvider([PRIMARY, SECOND]),
      store: new InMemoryUiPreferenceStore(storage),
      floor: 32,
      onDisplaysChanged: () => undefined
    })

    expect(() => use?.load()).not.toThrow()
    expect(starts).toBe(1)
    expect(built.panel().bounds).toEqual(
      panelBounds(PRIMARY.workArea, 'right', { mineOpen: false, dockOpen: false }, 32)
    )
  })
})

describe('the Panel window closed by the OS (ISSUE-056; 16 §4.14 read-backs, visible)', () => {
  it('[US-SHELL-002.AC01] a Panel closed outside the app reads as not on screen, and the next toggle shows it again', () => {
    const { panel, window } = subject()
    panel.show()
    expect(panel.visible()).toBe(true)

    // The OS or the person closed the window; the use case was not asked.
    window().visible = false

    expect(panel.visible(), 'A-05 answers what the window is').toBe(false)
    panel.toggleVisible()
    expect(window().visible, 'the toggle shows it, not hides it').toBe(true)
    expect(panel.visible()).toBe(true)
  })
})
