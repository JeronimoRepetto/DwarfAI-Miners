import { describe, expect, it } from 'vitest'
import { RAIL_WIDTH } from './panelBounds'
import {
  applyAlwaysOnTop,
  applyPanelBounds,
  buildMainWindowOptions,
  type AlwaysOnTopTarget,
  type PanelBoundsTarget
} from './window'

/**
 * The rail the redesigned shell opens as (#90) — a rectangle main derived from
 * the display before the window existed, which this file only has to carry
 * through untouched.
 */
const RAIL_BOUNDS = { x: 1900, y: 0, width: RAIL_WIDTH, height: 1032 }

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

describe('buildMainWindowOptions', () => {
  const input = {
    alwaysOnTop: true,
    preloadPath: 'C:/app/out/preload/index.mjs',
    iconPath: 'C:/app/resources/app-icon.png',
    bounds: RAIL_BOUNDS
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
 * is never drawn below the box it was authored in — did not go with them: it
 * moved to `panelBounds.test.ts`, which holds the MINE COLUMN to
 * `MIN_PANEL_SIZE.width` and the copied scene chrome to `PANEL_CHROME.width`,
 * because that column is where the cave now lives.
 */
describe('buildMainWindowOptions docked bounds', () => {
  const input = {
    alwaysOnTop: true,
    preloadPath: 'C:/app/out/preload/index.mjs',
    iconPath: 'C:/app/resources/app-icon.png',
    bounds: RAIL_BOUNDS
  }

  it('gives the docked panel no size for a user to drag', () => {
    const options = buildMainWindowOptions(input)
    expect(options.resizable).toBe(false)
    // A floor would fight the rail rather than protect anything: the rail is
    // 20px wide on purpose, and main is the only thing that sets these bounds.
    expect(options.minWidth).toBeUndefined()
    expect(options.minHeight).toBeUndefined()
  })

  it('opens exactly on the rail rectangle it was handed', () => {
    const options = buildMainWindowOptions(input)
    expect(options.x).toBe(RAIL_BOUNDS.x)
    expect(options.y).toBe(RAIL_BOUNDS.y)
    expect(options.width).toBe(RAIL_WIDTH)
    expect(options.height).toBe(RAIL_BOUNDS.height)
  })

  it('never adjusts those bounds for the pin preference', () => {
    // Every shape the pin preference can put the builder in still lands on the
    // same rectangle: where the panel hangs is a property of the display, not
    // of the user's pin choice.
    for (const alwaysOnTop of [true, false]) {
      const options = buildMainWindowOptions({ ...input, alwaysOnTop })
      expect({ x: options.x, y: options.y, width: options.width, height: options.height }).toEqual(
        RAIL_BOUNDS
      )
    }
  })
})

/**
 * Moving the docked panel between the rail and the open panel (#90).
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
    expect(applyPanelBounds(target, RAIL_BOUNDS)).toEqual(RAIL_BOUNDS)
    expect(calls).toEqual([RAIL_BOUNDS])
  })

  it('reports the REAL rectangle, never the wish, when the window manager refuses', () => {
    const { target } = fakeBoundsWindow({ honorsChanges: false })
    expect(applyPanelBounds(target, RAIL_BOUNDS)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})
