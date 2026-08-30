import { describe, expect, it } from 'vitest'
import { AUTHORED_PANEL_SIZE, MIN_PANEL_SIZE } from '../renderer/src/lib/sceneSizing'
import { applyAlwaysOnTop, buildMainWindowOptions, type AlwaysOnTopTarget } from './window'

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
    iconPath: 'C:/app/resources/app-icon.png'
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
 * Issue #44 — the panel is resizable and 460x600 was only ever its STARTING
 * size, so a user could drag it down to whatever Electron allows and the scene
 * had no say in it. `minWidth`/`minHeight` are the cheap half of the fix: they
 * make the floor unreachable rather than merely undesirable.
 *
 * The numbers are not a taste call. They are the smallest cave box at which
 * every authored anchor still lands inside the `object-fit: cover` crop with a
 * whole sprite footprint of clearance, plus the chrome around that box — all of
 * it derived in `renderer/src/lib/sceneSizing.ts` from the art, the anchors and
 * the cave's own declared min-height. main cannot import that module at runtime
 * (renderer code has no business in the main bundle), so it carries the two
 * numbers and this test is what holds them to the derivation.
 */
describe('buildMainWindowOptions minimum size', () => {
  const input = {
    alwaysOnTop: true,
    preloadPath: 'C:/app/out/preload/index.mjs',
    iconPath: 'C:/app/resources/app-icon.png'
  }

  it('gives the resizable panel a floor it cannot be dragged below', () => {
    const options = buildMainWindowOptions(input)
    expect(options.resizable).toBe(true)
    expect(options.minWidth).toBe(MIN_PANEL_SIZE.width)
    expect(options.minHeight).toBe(MIN_PANEL_SIZE.height)
  })

  it('opens at the authored size the scene was drawn against, above that floor', () => {
    const options = buildMainWindowOptions(input)
    expect(options.width).toBe(AUTHORED_PANEL_SIZE.width)
    expect(options.height).toBe(AUTHORED_PANEL_SIZE.height)
    expect(options.width!).toBeGreaterThanOrEqual(options.minWidth!)
    expect(options.height!).toBeGreaterThanOrEqual(options.minHeight!)
  })

  it('never hands Electron a window it could create below the scene minimum', () => {
    // Every shape the pin preference can put the builder in still carries it:
    // the floor is a property of the scene, not of the user's pin choice.
    for (const alwaysOnTop of [true, false]) {
      const options = buildMainWindowOptions({ ...input, alwaysOnTop })
      expect(options.minWidth, `${alwaysOnTop}`).toBe(MIN_PANEL_SIZE.width)
      expect(options.minHeight, `${alwaysOnTop}`).toBe(MIN_PANEL_SIZE.height)
    }
  })
})
