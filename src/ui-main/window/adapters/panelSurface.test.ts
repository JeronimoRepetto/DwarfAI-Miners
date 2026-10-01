// layer: L3
import { describe, expect, it } from 'vitest'
import { DESIGN_SCREEN_HEIGHT, uiScale } from '../domain/panelBounds'
import {
  applyAlwaysOnTop,
  applyPanelBounds,
  applyUiScale,
  raisePanelWindow,
  type AlwaysOnTopTarget,
  type PanelBoundsTarget,
  type RaiseTarget,
  type UiScaleTarget
} from './panelSurface'

/*
 * TRANSPLANTED for ISSUE-047 from src/main/shell/window.test.ts (05 §3.14 `ElectronWindows` ← `shell/window.ts`;
 * 21 §6: replaced). Run unchanged first (17 §2.5), the legacy file cannot load against the rebuilt window module: its
 * subject is the legacy module with its module-level window. The read-back helpers it tests over narrow
 * `BrowserWindow` slices are kept as they are here, behind the Panel window's surface (`ElectronWindows.panelSurface`):
 * the pin read-back (A-04; FM-052), the page zoom (#153), the bounds read-back (#90) and the raise of a click (A-02,
 * #165). Each case below keeps its title, its fake and its expectation; only the import paths changed. The legacy file
 * is untouched; it leaves with ISSUE-058.
 */

/**
 * The Panel the redesigned shell opens as (#90) — a rectangle main derived from
 * the display before the window existed, which this file only has to carry
 * through untouched.
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
