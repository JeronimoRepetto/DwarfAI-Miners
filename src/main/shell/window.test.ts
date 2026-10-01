import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ScreenRect } from '../platform/screenArea'
import { DESIGN_SCREEN_HEIGHT, uiScale } from './panelBounds'
/*
 * AMENDED for #635: this file crossed the main -> renderer boundary once, to pin the message
 * panel window's deferred hide against the renderer's own leave bound (MESSAGE_PANEL_LEAVE_TIMEOUT_MS
 * against motionBoundMs). That window is gone, and with it the pin and the import; the guarantee
 * has no second copy left to hold equal.
 */
import {
  applyAlwaysOnTop,
  applyPanelBounds,
  // ADDED for #570 — the page load split out of createMainWindow.
  applyPanelPageLoad,
  type PanelPageTarget,
  loadPanelPage,
  applyUiScale,
  buildMainWindowOptions,
  fitShellWindow,
  formatShellFit,
  refitOnDisplayChange,
  // ADDED for the destroyed-window crash at quit — the display listeners' lifetime.
  refitWhileOpen,
  type DisplayChangeEvent,
  type DisplayChangeSource,
  formatShellTrace,
  panelLayout,
  raisePanelWindow,
  seedPanelEdge,
  setPanelLayout,
  type AlwaysOnTopTarget,
  type PanelBoundsTarget,
  type RaiseTarget,
  type UiScaleTarget
} from './window'

/**
 * The Panel the redesigned shell opens as (#90) — a rectangle main derived from
 * the display before the window existed, which this file only has to carry
 * through untouched. AMENDED for #635 (was: `PANEL_BOUNDS`, the closed 20px
 * rail's rectangle): the rail is gone, so the window opens as the Panel itself,
 * the nav and the page (`panelBounds.test.ts` derives the width).
 */
const PANEL_BOUNDS = { x: 1402, y: 0, width: 518, height: 1032 }

/**
 * Deterministic BrowserWindow stand-in for the always-on-top surface: it
 * records every set call and can be told to refuse the change, the way a
 * window manager that ignores the hint would (some Linux compositors do).
 */
function fakeWindow(options: { honorsChanges?: boolean; initial?: boolean } = {}) {
  let real = options.initial ?? false
  const calls: boolean[] = []
  const target: AlwaysOnTopTarget = {
    setAlwaysOnTop: (flag) => {
      calls.push(flag)
      if (options.honorsChanges !== false) real = flag
    },
    isAlwaysOnTop: () => real
  }
  return { target, calls }
}

describe('applyAlwaysOnTop', () => {
  it('applies the request and reports the state read back from the window', () => {
    const { target, calls } = fakeWindow()
    expect(applyAlwaysOnTop(target, true)).toBe(true)
    expect(applyAlwaysOnTop(target, false)).toBe(false)
    expect(calls).toEqual([true, false])
  })

  it('reports the REAL state, never the wish, when the platform refuses the change', () => {
    const { target } = fakeWindow({ honorsChanges: false, initial: false })
    expect(applyAlwaysOnTop(target, true)).toBe(false)
  })
})

/**
 * The shell as a 1080-designed surface scaled onto the display (#153).
 *
 * Same read-back rule as the pin and the bounds: Electron forwards the request
 * and the answer is what the page ACTUALLY got, because a zoom the renderer
 * refused would leave main computing a window for a surface that is not there.
 */
function fakeZoomTarget(options: { honorsChanges?: boolean; roundsTrip?: boolean } = {}) {
  let real = 1
  const calls: number[] = []
  const target: UiScaleTarget = {
    setZoomFactor: (factor) => {
      calls.push(factor)
      if (options.honorsChanges !== false) real = factor
    },
    /*
     * AMENDED for #388 (was: `() => real`). Chromium stores zoom as a
     * logarithmic LEVEL and answers with `1.2 ** level`, so the factor a page
     * reports is the one that was set give or take the last bit. `roundsTrip`
     * is a page that does exactly that, which is what any real one does.
     */
    getZoomFactor: () =>
      options.roundsTrip === true ? Math.pow(1.2, Math.log(real) / Math.log(1.2)) : real,
    // ADDED for #635 (window fit): a page already on its own zoom; see "each window keeps its own
    // zoom" for one that is not.
    getZoomMode: () => 'isolated',
    setZoomMode: () => undefined
  }
  /** The zoom Electron drops on every navigation, without recording a call. */
  const lose = (): void => {
    real = 1
  }
  return { target, calls, lose }
}

/*
 * ADDED for #635 (window fit). Chromium keeps a page's zoom per ORIGIN by default, and the shell
 * and the message panel load the same page: zooming one zooms the other (Electron's
 * `setZoomLevel`, whose note points at `setZoomMode('isolated')` for per-webContents zoom). The
 * message panel is scaled for the display IT is on, so a panel on a display of another height
 * gave the shell a zoom its window was never sized for. The fake shares one factor between two
 * pages exactly while neither is isolated.
 */
describe('each window keeps its own zoom', () => {
  function sameOriginPages() {
    let shared = 1
    function page(): UiScaleTarget {
      let mode: 'default' | 'isolated' | 'manual' | 'disabled' = 'default'
      let own = shared
      return {
        getZoomMode: () => mode,
        setZoomMode: (next) => {
          if (next === 'isolated' && mode !== 'isolated') own = shared
          mode = next
        },
        setZoomFactor: (factor) => {
          if (mode === 'isolated') own = factor
          else shared = factor
        },
        getZoomFactor: () => (mode === 'isolated' ? own : shared)
      }
    }
    return { shell: page(), panel: page() }
  }

  it('keeps the shell’s factor when the message panel is scaled for another display', () => {
    const { shell, panel } = sameOriginPages()
    const twoK = { x: 0, y: 0, width: 2560, height: 1392 }
    applyUiScale(shell, twoK)
    applyUiScale(panel, { x: 2560, y: 0, width: 1920, height: DESIGN_SCREEN_HEIGHT })
    expect(shell.getZoomFactor()).toBe(uiScale(twoK))
    expect(panel.getZoomFactor()).toBe(1)
  })
})

describe('applyUiScale', () => {
  it('zooms the page by the display’s own height against the design world', () => {
    const { target, calls } = fakeZoomTarget()
    const area = { x: 0, y: 0, width: 3840, height: 2160 }
    expect(applyUiScale(target, area)).toBe(2)
    expect(calls).toEqual([2])
  })

  it('leaves a display that IS the design world at 1, so nothing is resampled', () => {
    const { target } = fakeZoomTarget()
    expect(applyUiScale(target, { x: 0, y: 0, width: 1920, height: DESIGN_SCREEN_HEIGHT })).toBe(1)
  })

  it('applies the same continuous factor the window’s own width is derived from', () => {
    const { target, calls } = fakeZoomTarget()
    const twoK = { x: 0, y: 0, width: 2560, height: 1392 }
    applyUiScale(target, twoK)
    // The panel's physical width and the renderer's zoom have to come from one
    // number: if they ever disagree the columns main reserved stop matching the
    // columns the renderer draws, which is invisible until something clips.
    expect(calls).toEqual([uiScale(twoK)])
  })

  it('reports the REAL factor, never the wish, when the page refuses it', () => {
    const { target } = fakeZoomTarget({ honorsChanges: false })
    expect(applyUiScale(target, { x: 0, y: 0, width: 3840, height: 2160 })).toBe(1)
  })

  /*
   * ADDED for #388. `setPanelLayout` re-applies the scale on every layout
   * change, because a layout change can carry the window onto another display —
   * and most of them do not. Whether an unchanged `setZoomFactor` costs the
   * renderer a relayout is UNMEASURED here; not asking it in the frame the
   * shell's fold is running in costs nothing either way.
   */
  it('leaves a page that already has the factor alone', () => {
    const { target, calls } = fakeZoomTarget()
    const area = { x: 0, y: 0, width: 3840, height: 2160 }
    applyUiScale(target, area)
    applyUiScale(target, area)
    expect(calls).toEqual([2])
  })

  it('reads a factor the page rounded through its zoom level as the same factor', () => {
    const { target, calls } = fakeZoomTarget({ roundsTrip: true })
    const twoK = { x: 0, y: 0, width: 2560, height: 1392 }
    applyUiScale(target, twoK)
    applyUiScale(target, twoK)
    expect(calls).toEqual([uiScale(twoK)])
  })

  it('gives the factor back to a page that lost it, which every navigation does', () => {
    const { target, calls, lose } = fakeZoomTarget()
    const area = { x: 0, y: 0, width: 3840, height: 2160 }
    applyUiScale(target, area)
    lose()
    expect(applyUiScale(target, area)).toBe(2)
    expect(calls).toEqual([2, 2])
  })
})

describe('buildMainWindowOptions', () => {
  const input = {
    alwaysOnTop: true,
    preloadPath: 'C:/app/out/preload/index.mjs',
    iconPath: 'C:/app/resources/app-icon.png',
    bounds: PANEL_BOUNDS
  }

  it('applies the stored pin preference at creation', () => {
    expect(buildMainWindowOptions({ ...input, alwaysOnTop: true }).alwaysOnTop).toBe(true)
    expect(buildMainWindowOptions({ ...input, alwaysOnTop: false }).alwaysOnTop).toBe(false)
  })

  it('keeps the frameless floating-panel invariants regardless of the pin preference', () => {
    const options = buildMainWindowOptions({ ...input, alwaysOnTop: false })
    expect(options.frame).toBe(false)
    expect(options.transparent).toBe(true)
    expect(options.skipTaskbar).toBe(true)
    expect(options.show).toBe(false)
  })

  it('drops the Windows thick frame, whose DWM animation is what flashed the whole shell on every resize (#394)', () => {
    // Windows-only by definition; the two things it costs are already gone
    // here — the window is not resizable and the shell paints its own shadow.
    expect(buildMainWindowOptions(input).thickFrame).toBe(false)
  })

  /*
   * ADDED for #465. `thickFrame: false` above is Windows-only by definition, so
   * the native shadow it removed there is still drawn on macOS — around the
   * TRANSPARENT window's shape, which the fold (#388) shrinks to a 20px bar
   * while the window stays the full height. What the maintainer photographed is
   * that shadow standing past the ends of the rail. The rail carries its own
   * `--elevation-5`, so the OS one was a second shadow on every platform.
   */
  it('paints no native shadow, because the shell paints its own (#465)', () => {
    expect(buildMainWindowOptions(input).hasShadow).toBe(false)
    // Stated together: dropping the OS shadow must not cost the option that
    // stopped the Windows resize flash (#394), which removes the other one.
    expect(buildMainWindowOptions(input).thickFrame).toBe(false)
  })

  it('wires the preload and icon paths through untouched', () => {
    const options = buildMainWindowOptions(input)
    expect(options.webPreferences?.preload).toBe(input.preloadPath)
    expect(options.icon).toBe(input.iconPath)
  })

  it('keeps the renderer sandboxed from Node and isolated from the preload world', () => {
    const options = buildMainWindowOptions(input)
    expect(options.webPreferences?.contextIsolation).toBe(true)
    expect(options.webPreferences?.nodeIntegration).toBe(false)
  })

  /*
   * The music has to start on its own (#174), and Chromium's autoplay policy
   * will not let it: a page that has had no user gesture cannot start audio,
   * and this window is created hidden and shown by a global shortcut or the
   * tray — neither of which is a gesture ON the page. The documented switch is
   * this one, and it is stated here so a future edit cannot drop it and leave
   * a silent launch that only shows up by ear.
   */
  it('lets the renderer start audio without a user gesture, which #174 needs', () => {
    expect(buildMainWindowOptions(input).webPreferences?.autoplayPolicy).toBe(
      'no-user-gesture-required'
    )
  })
})

/*
 * Issue #44 gave the free-floating panel a `minWidth`/`minHeight` floor, because
 * 460x600 was only ever a STARTING size on a resizable window and a user could
 * drag the cave below the smallest box its anchors were authored in.
 *
 * The redesigned shell (#90) is DOCKED: main derives its rectangle from the
 * display and from whether the panel is open, so there is no size to drag and a
 * 20px rail cannot coexist with a 276px floor. These three tests kept their
 * subject — the window Electron is asked to create — and changed what they
 * assert about it.
 *
 * REMOVED with them, stated here rather than passing unseen: the assertions
 * holding `minWidth`/`minHeight` to `MIN_PANEL_SIZE` and `width`/`height` to
 * `AUTHORED_PANEL_SIZE`, and this file's import of both from
 * `renderer/src/lib/scene/sceneSizing`. The guarantee they enforced — the cave
 * is never drawn below the box it was authored in — did not go with them, but
 * it did move twice more the same day: `MIN_PANEL_SIZE` and `PANEL_CHROME`
 * themselves went with the cave (#137), and #153 replaced the fixed pairing
 * with a derived one. It lives today in `panelBounds.test.ts`'s "the derived
 * columns", which pins the MINE COLUMN main derives against the renderer's
 * own `interiorColumnWidth`/`DESIGN_INTERIOR_WIDTH`/`SHELL_CONTENT_INSET` —
 * this file holds no cross-process import because it has nothing left to pin
 * (see AGENTS.md's boundaries section).
 */
describe('buildMainWindowOptions docked bounds', () => {
  const input = {
    alwaysOnTop: true,
    preloadPath: 'C:/app/out/preload/index.mjs',
    iconPath: 'C:/app/resources/app-icon.png',
    bounds: PANEL_BOUNDS
  }

  it('gives the docked panel no size for a user to drag', () => {
    const options = buildMainWindowOptions(input)
    expect(options.resizable).toBe(false)
    // A floor would protect nothing: main is the only thing that sets these
    // bounds, and it derives them from what the Panel shows.
    expect(options.minWidth).toBeUndefined()
    expect(options.minHeight).toBeUndefined()
  })

  // AMENDED for #635 (was: "…on the rail rectangle…", asserting the rail's 20px width).
  it('opens exactly on the rectangle it was handed', () => {
    const options = buildMainWindowOptions(input)
    expect(options.x).toBe(PANEL_BOUNDS.x)
    expect(options.y).toBe(PANEL_BOUNDS.y)
    expect(options.width).toBe(PANEL_BOUNDS.width)
    expect(options.height).toBe(PANEL_BOUNDS.height)
  })

  it('never adjusts those bounds for the pin preference', () => {
    // Every shape the pin preference can put the builder in still lands on the
    // same rectangle: where the panel hangs is a property of the display, not
    // of the user's pin choice.
    for (const alwaysOnTop of [true, false]) {
      const options = buildMainWindowOptions({ ...input, alwaysOnTop })
      expect({ x: options.x, y: options.y, width: options.width, height: options.height }).toEqual(
        PANEL_BOUNDS
      )
    }
  })
})

/**
 * The page load that used to happen inside createMainWindow itself (#570).
 *
 * `createMainWindow` used to end by starting this load fire-and-forget —
 * before index.ts had registered its own `ipcMain.handle` surface, several
 * hundred lines later. A renderer fast enough to mount before that
 * registration finished invoked `mines:get` onto a channel nobody was
 * listening on yet, and Electron rejected it as "No handler registered for
 * channel": silent in `pnpm dev`, where the dev server's own page load is slow
 * enough to lose that race almost every time, and reliable in a packaged
 * build, where `loadFile` reads local bytes and wins it (issue #570).
 *
 * The fix is to stop loading the page from inside window creation at all:
 * `loadPanelPage` is now the only thing that starts this load, and index.ts
 * calls it once, after the last `ipcMain` registration.
 *
 * `createMainWindow` itself is not exercised here, for the same reason no
 * other test in this file constructs one: a real `BrowserWindow` cannot be
 * built outside an actual Electron process — `require('electron')` there
 * resolves to the path of its binary, not the module — so what is provable in
 * this suite is the branch `loadPanelPage` performs, against a fake target.
 */
describe('applyPanelPageLoad (#570)', () => {
  function fakePageTarget() {
    const calls: { method: 'loadURL' | 'loadFile'; arg: string }[] = []
    const target: PanelPageTarget = {
      loadURL: (url) => {
        calls.push({ method: 'loadURL', arg: url })
      },
      loadFile: (filePath) => {
        calls.push({ method: 'loadFile', arg: filePath })
      }
    }
    return { target, calls }
  }

  it('loads the dev server page when ELECTRON_RENDERER_URL names one', () => {
    const { target, calls } = fakePageTarget()
    applyPanelPageLoad(target, { ELECTRON_RENDERER_URL: 'http://localhost:5173' })
    expect(calls).toEqual([{ method: 'loadURL', arg: 'http://localhost:5173' }])
  })

  it('loads the packaged file when there is no dev server to name one', () => {
    const { target, calls } = fakePageTarget()
    applyPanelPageLoad(target, {})
    expect(calls).toEqual([
      { method: 'loadFile', arg: join(import.meta.dirname, '../renderer/index.html') }
    ])
  })
})

describe('loadPanelPage (#570)', () => {
  it('is a no-op with no window, like showPanel and placeMessagePanel guard', () => {
    // No test in this file ever calls createMainWindow() (see the block
    // comment above), so module-scope `mainWindow` is still null here — which
    // is exactly the state this guard exists for.
    expect(() => loadPanelPage()).not.toThrow()
  })
})

/**
 * Moving the docked panel between its compositions (#90, #635).
 *
 * The read-back is the point, exactly as it is for the pin: Electron forwards a
 * bounds request and a compositor may place the window somewhere else — a
 * tiling window manager will simply ignore it — so the renderer has to be told
 * what the window became, never what was asked for.
 */
describe('applyPanelBounds', () => {
  function fakeBoundsWindow(options: { honorsChanges?: boolean } = {}) {
    let real = { x: 0, y: 0, width: 0, height: 0 }
    const calls: { x: number; y: number; width: number; height: number }[] = []
    const target: PanelBoundsTarget = {
      setBounds: (bounds) => {
        calls.push(bounds)
        if (options.honorsChanges !== false) real = bounds
      },
      getBounds: () => real
    }
    return { target, calls }
  }

  it('applies the rectangle and reports what the window read back', () => {
    const { target, calls } = fakeBoundsWindow()
    expect(applyPanelBounds(target, PANEL_BOUNDS)).toEqual(PANEL_BOUNDS)
    expect(calls).toEqual([PANEL_BOUNDS])
  })

  it('reports the REAL rectangle, never the wish, when the window manager refuses', () => {
    const { target } = fakeBoundsWindow({ honorsChanges: false })
    expect(applyPanelBounds(target, PANEL_BOUNDS)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

/*
 * ADDED for #635 (window fit). One pass over the shell window: its zoom, its bounds sized at that
 * zoom, and the layout the window it ended up as can actually hold — the one the renderer is
 * told, so that it never draws a column into a window that has no room for it.
 */
describe('fitShellWindow', () => {
  const area = { x: 0, y: 0, width: 2560, height: 1392 }
  const layout = { edge: 'right' as const, mineOpen: true, dockOpen: false }

  function fakeShell(options: { widest?: number } = {}) {
    let real = { x: 0, y: 0, width: 0, height: 0 }
    const asked: number[] = []
    let zoom = 1
    return {
      asked,
      target: {
        setBounds: (bounds: { x: number; y: number; width: number; height: number }) => {
          asked.push(bounds.width)
          real = { ...bounds, width: Math.min(bounds.width, options.widest ?? Infinity) }
        },
        getBounds: () => real,
        webContents: {
          setZoomFactor: (factor: number) => {
            zoom = factor
          },
          getZoomFactor: () => zoom,
          getZoomMode: () => 'isolated' as const,
          setZoomMode: () => undefined
        }
      }
    }
  }

  it('holds the whole layout in a window that took the width it was asked', () => {
    const { target } = fakeShell()
    const fit = fitShellWindow(target, area, layout, 'win32')
    expect(fit.held).toEqual({ mineOpen: true, dockOpen: false })
    expect(fit.appliedWidth).toBe(fit.requestedWidth)
    expect(fit.zoom).toBe(uiScale(area))
  })

  it('reports the page alone, sized for it, when the window refused to grow for the mine', () => {
    const { target, asked } = fakeShell({ widest: 668 })
    const fit = fitShellWindow(target, area, layout, 'win32')
    expect(fit.held).toEqual({ mineOpen: false, dockOpen: false })
    expect(fit.requestedWidth).toBe(1062)
    // Asked again for the layout it holds, so the docked edge stays where the design puts it.
    expect(asked).toEqual([1062, 668])
    expect(fit.appliedWidth).toBe(668)
  })
})

/*
 * ADDED for #635 (window fit). A display that changes under the shell — a resolution or scale
 * change, a monitor plugged in or out, a taskbar appearing — leaves it sized and zoomed for a
 * display that is no longer there. Only the moved message panel was refitted (#296); the shell
 * waited for the next layout change or show. The shell goes first, because the docked panel is
 * placed against the shell's new rectangle.
 */
/*
 * ADDED for #635 (window fit). The PO's cut Panel could not be reproduced on the one display it
 * was checked on, and a run that goes wrong elsewhere has to say why on its own: one line per
 * fit, geometry and counts only — nothing that names a person, a path or a project.
 */
describe('formatShellFit', () => {
  it('names the work area, the zoom, the width asked and got in both units, and the displays', () => {
    const line = formatShellFit(
      { x: 0, y: 0, width: 2560, height: 1392 },
      {
        held: { mineOpen: false, dockOpen: false },
        zoom: 1.288888888888889,
        requestedWidth: 1062,
        appliedWidth: 668
      },
      { mineOpen: true, dockOpen: false },
      2
    )
    expect(line).toBe(
      '[shell] layout applied: area=2560x1392@0,0 zoom=1.2889 requested=1062 applied=668 ' +
        'requestedCss=824 appliedCss=518.3 asked=mine held=page displays=2'
    )
  })
})

describe('refitOnDisplayChange', () => {
  // AMENDED for #635 (was: 'refits the shell, then the message panel against it'): the panel is in
  // the shell's dock slot, so refitting the shell is refitting everything the app draws.
  it('refits the shell, which holds every panel the app draws', () => {
    const steps: string[] = []
    const refit = refitOnDisplayChange({ fitShell: () => steps.push('shell') })
    refit()
    expect(steps).toEqual(['shell'])
  })
})

/**
 * The display listeners live exactly as long as the window they refit.
 *
 * CI on macOS caught the main process throwing `TypeError: Object has been destroyed` at quit: a
 * display event landed after the shell window was destroyed, and the refit it triggered asked the
 * dead window for its bounds. In a packaged app that is Electron's modal "A JavaScript error
 * occurred in the main process" box, and a quit that never finishes.
 */
describe('refitWhileOpen', () => {
  const DISPLAY_EVENTS: DisplayChangeEvent[] = [
    'display-metrics-changed',
    'display-added',
    'display-removed'
  ]

  /** `screen`'s display events, with one listener of somebody else's already on each. */
  function fakeScreen() {
    const listeners = new Map<DisplayChangeEvent, Array<() => void>>(
      DISPLAY_EVENTS.map((event) => [event, [() => undefined]])
    )
    const source: DisplayChangeSource = {
      on: (event, listener) => {
        listeners.get(event)?.push(listener)
      },
      removeListener: (event, listener) => {
        const list = listeners.get(event) ?? []
        const at = list.indexOf(listener)
        if (at !== -1) list.splice(at, 1)
      }
    }
    return {
      source,
      emit: (event: DisplayChangeEvent) => {
        for (const listener of [...(listeners.get(event) ?? [])]) listener()
      },
      count: (event: DisplayChangeEvent) => listeners.get(event)?.length ?? 0
    }
  }

  /** A BrowserWindow that, once destroyed, throws on `getBounds` the way Electron's does. */
  function fakeClosingWindow() {
    let destroyed = false
    let onClosed: (() => void) | null = null
    let boundsReadsAfterDestroy = 0
    return {
      target: {
        once: (_event: 'closed', listener: () => void) => {
          onClosed = listener
        }
      },
      getBounds: (): ScreenRect => {
        if (destroyed) {
          boundsReadsAfterDestroy += 1
          throw new TypeError('Object has been destroyed')
        }
        return PANEL_BOUNDS
      },
      close: () => {
        destroyed = true
        onClosed?.()
      },
      boundsReadsAfterDestroy: () => boundsReadsAfterDestroy
    }
  }

  it('refits on every display event while the window is open, and never after it closed', () => {
    const screen = fakeScreen()
    const window = fakeClosingWindow()
    let fits = 0
    refitWhileOpen(window.target, screen.source, {
      fitShell: () => {
        window.getBounds()
        fits += 1
      },
      closed: () => undefined
    })

    for (const event of DISPLAY_EVENTS) screen.emit(event)
    expect(fits).toBe(3)

    window.close()
    expect(() => {
      for (const event of DISPLAY_EVENTS) screen.emit(event)
    }).not.toThrow()
    expect(window.boundsReadsAfterDestroy()).toBe(0)
    expect(fits).toBe(3)
  })

  it('removes its display listeners and reports the close once the window is closed', () => {
    const screen = fakeScreen()
    const window = fakeClosingWindow()
    const before = DISPLAY_EVENTS.map((event) => screen.count(event))
    let closed = 0
    refitWhileOpen(window.target, screen.source, {
      fitShell: () => undefined,
      closed: () => {
        closed += 1
      }
    })
    expect(DISPLAY_EVENTS.map((event) => screen.count(event))).toEqual(before.map((n) => n + 1))

    window.close()
    expect(DISPLAY_EVENTS.map((event) => screen.count(event))).toEqual(before)
    expect(closed).toBe(1)
  })
})

/**
 * The Settings position control (#138): the docked side is now settable, and
 * it persists. No real BrowserWindow exists in either test here (`mainWindow`
 * stays null at module scope until createMainWindow() runs), so setPanelLayout
 * only has to prove what it computes — applyPanelBounds against a live window
 * is already covered above.
 */
describe('panel layout edge (#138)', () => {
  it('seeds the persisted edge before any window exists, for the very first frame', () => {
    seedPanelEdge('left')
    expect(panelLayout().edge).toBe('left')
    seedPanelEdge('right')
    expect(panelLayout().edge).toBe('right')
  })

  it('keeps the current edge when a request does not name one', () => {
    // A mine opening and the dock opening both send bare mineOpen/dockOpen
    // requests; neither is the position control, and neither may nudge the
    // docked side by accident. AMENDED for #635 (was: the rail toggle's
    // `expanded`, which went with the rail).
    seedPanelEdge('left')
    expect(setPanelLayout({ mineOpen: true, dockOpen: false }).edge).toBe('left')
    expect(setPanelLayout({ mineOpen: false, dockOpen: true }).edge).toBe('left')
  })

  it('moves to the requested edge when the position control asks for one', () => {
    seedPanelEdge('right')
    const result = setPanelLayout({ mineOpen: false, dockOpen: false, edge: 'left' })
    expect(result.edge).toBe('left')
    expect(panelLayout().edge).toBe('left')
  })

  // AMENDED for #635 (was: "carries expanded and mineOpen…"): `dockOpen` replaced `expanded`.
  it('carries mineOpen and dockOpen through unchanged alongside an edge move', () => {
    seedPanelEdge('right')
    const result = setPanelLayout({ mineOpen: true, dockOpen: true, edge: 'left' })
    expect(result).toEqual({ edge: 'left', mineOpen: true, dockOpen: true })
  })

  /*
   * ADDED for #635 (PO ruling 2026-09-27). The window used to be created as the closed rail,
   * and the first press on it opened the page. With the rail gone, the window the global
   * shortcut and the tray first show is the Panel itself: the nav and the page, nothing beside.
   */
  it('starts as the Panel with nothing beside its page, before anything is asked of it', async () => {
    vi.resetModules()
    const fresh = await import('./window')
    expect(fresh.panelLayout()).toEqual({ edge: 'right', mineOpen: false, dockOpen: false })
  })
})

/**
 * The third acceptance run's sixth correction (#165).
 *
 * With another program focused, clicking DwarfAI-Miners left the window BEHIND
 * it — alive, visible, receiving the click, and never raised. The shell is a
 * frameless TRANSPARENT window (a layered window on Windows), which is the one
 * combination the platform's own click-to-front does not reliably apply, and
 * nothing in the app compensated: the only focus() in the whole process was
 * showPanel's.
 *
 * The rule the maintainer set is simple enough to test as one: a click anywhere
 * on the shell raises AND focuses it, pinned or not. So the renderer reports the
 * click and this is what main does with it.
 */
describe('raisePanelWindow', () => {
  function fakeRaiseTarget(state: { visible?: boolean; minimized?: boolean } = {}) {
    const calls: string[] = []
    const target: RaiseTarget = {
      isVisible: () => state.visible ?? true,
      isMinimized: () => state.minimized ?? false,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      moveTop: () => calls.push('moveTop'),
      focus: () => calls.push('focus')
    }
    return { target, calls }
  }

  it('raises the window above the stack and then focuses it', () => {
    // moveTop before focus, because the two are different asks: one is z-order
    // and the other is keyboard focus, and a window focused underneath another
    // is exactly the state the maintainer photographed.
    const { target, calls } = fakeRaiseTarget()
    raisePanelWindow(target)
    expect(calls).toEqual(['moveTop', 'focus'])
  })

  it('raises a window the user minimized rather than leaving it in the taskbar', () => {
    const { target, calls } = fakeRaiseTarget({ minimized: true })
    raisePanelWindow(target)
    expect(calls).toEqual(['restore', 'moveTop', 'focus'])
  })

  it('never shows a window that is deliberately hidden', () => {
    // Hidden is the tray state, and the click that reaches this cannot have
    // landed on a window nobody can see. Showing one would make a stray call
    // from the renderer into a way to reopen the panel behind the user's back.
    const { target, calls } = fakeRaiseTarget({ visible: false })
    raisePanelWindow(target)
    expect(calls).toEqual([])
  })
})

describe('the shell window can be focused at all', () => {
  it('is focusable, stated rather than left to the default (#165)', () => {
    // The one flag that would silently undo the raise above: a window Electron
    // was told not to focus cannot be focused by anything, click included.
    const options = buildMainWindowOptions({
      alwaysOnTop: false,
      preloadPath: 'C:/app/out/preload/index.mjs',
      iconPath: 'C:/app/resources/app-icon.png',
      bounds: PANEL_BOUNDS
    })
    expect(options.focusable).toBe(true)
  })
})
/*
 * REMOVED for #635, stated rather than passing unseen, with the functions they tested:
 * 'buildMessagePanelWindowOptions', 'setMessagePanel', 'focusMessagePanelOnSelection (#409)',
 * 'revealing a panel window nothing measured' (#312), 'hiding a panel window once its surface has
 * settled' (#389, with the pin of MESSAGE_PANEL_LEAVE_TIMEOUT_MS against the renderer's own leave
 * bound, the one crossing of the boundary this file made) and 'shellDebugEnabled' (#312). All of
 * them were the message panel's own window, and it is gone: the MessagePanel and the Add panel are
 * in this window's dock slot (decision log, MessagePanel and Add panel anchored). The keyboard the
 * selection focus gave that window is this one's: it is focusable ('the shell window can be
 * focused at all', above) and a press raises and focuses it ('raisePanelWindow').
 */

/**
 * One diagnostic line, and the shape the maintainer pastes back (#312).
 *
 * Pure and asserted for the reason every other decision in this file is: the
 * moments it describes all happen inside Electron, so the only part that can be
 * proven without a display is what the line SAYS — and a line missing the one
 * fact that separates a first open from a second one is a line that costs a
 * whole reproduction.
 */
describe('formatShellTrace', () => {
  // AMENDED for #635 throughout: the moments were the message panel window's, gone with it; the
  // line is still the shell's (formatShellFit), so the cases name shell moments.
  it('names the subject, the moment, and every fact after it', () => {
    expect(formatShellTrace('layout applied', { asked: 'mine', visible: false })).toBe(
      '[shell] layout applied: asked=mine visible=false'
    )
  })

  it('states a moment with nothing to add without a dangling colon', () => {
    expect(formatShellTrace('window close', {})).toBe('[shell] window close')
  })

  it('folds a rectangle into one field, so the line stays greppable', () => {
    // Size before origin, and no spaces inside the value: a rectangle split
    // across fields cannot be compared between two lines at a glance, and one
    // carrying a space stops being one field.
    expect(formatShellTrace('window created', { bounds: PANEL_BOUNDS })).toBe(
      '[shell] window created: bounds=518x1032@1402,0'
    )
  })

  /*
   * REMOVED for #635, stated rather than passing unseen: 'carries an anchor as the two numbers it
   * actually is, not as a rectangle'. The anchor was where a moved message panel was remembered
   * (#296), gone with its window; the line carries rectangles only.
   */

  it('says "none" for a fact that is absent, never nothing at all', () => {
    expect(formatShellTrace('window created', { bounds: null })).toBe(
      '[shell] window created: bounds=none'
    )
  })

  it('keeps the facts in the order they were written', () => {
    // Two lines from one run are read side by side, so the columns have to line
    // up: an object's own insertion order is the only order there is.
    expect(formatShellTrace('m', { a: 1, b: 2, c: 3 })).toBe('[shell] m: a=1 b=2 c=3')
  })
})
