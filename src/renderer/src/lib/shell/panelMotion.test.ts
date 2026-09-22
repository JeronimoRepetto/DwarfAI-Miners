// @vitest-environment jsdom
/**
 * `panelKeyframes` had no unit test of its own before #566 — only the shape
 * WAAPI callers happened to pass through `element.animate`, pinned inside
 * `PanelTransition.test.ts` and `MessagePanelWindow.test.ts`. Its return shape
 * changed with the motion-v swap, so it earns a direct one now, alongside
 * `panelMotionX` — new in this change, and the thing standing in for what the
 * browser's own `var(--panel-motion-x)` cascade used to resolve for free.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { panelKeyframes, panelMotionX } from './panelMotion'

afterEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('panelKeyframes', () => {
  it('rises vertically: opacity and y both go from hidden to shown', () => {
    expect(panelKeyframes(false, true)).toEqual({ opacity: [0, 1], y: [12, 0] })
  })

  it('leaves vertically: opacity and y both go from shown to hidden', () => {
    expect(panelKeyframes(true, true)).toEqual({ opacity: [1, 0], y: [0, 12] })
  })

  it('rises horizontally at the given offset, defaulting to 12px', () => {
    expect(panelKeyframes(false, false)).toEqual({ opacity: [0, 1], x: [12, 0] })
    expect(panelKeyframes(false, false, 12)).toEqual({ opacity: [0, 1], x: [12, 0] })
  })

  it('leaves horizontally at the given offset', () => {
    expect(panelKeyframes(true, false, 12)).toEqual({ opacity: [1, 0], x: [0, 12] })
  })

  /*
   * A left-docked shell mirrors the offset's SIGN (`.shell.edge-left` in
   * App.vue), never its opacity or which end it starts from — the same
   * pair `panelMotionX` reads off the element is what a horizontal caller is
   * expected to pass through here.
   */
  it('carries a negative offset through unchanged, for a left-docked shell', () => {
    expect(panelKeyframes(false, false, -12)).toEqual({ opacity: [0, 1], x: [-12, 0] })
    expect(panelKeyframes(true, false, -12)).toEqual({ opacity: [1, 0], x: [0, -12] })
  })
})

describe('panelMotionX', () => {
  it('defaults to 12px where nothing sets the custom property', () => {
    const element = document.createElement('div')
    document.body.append(element)
    expect(panelMotionX(element)).toBe(12)
    element.remove()
  })

  /*
   * `--panel-motion-x` inherits down the DOM the same way it did for WAAPI's
   * own `var(...)` lookup — this only moves WHEN it is read, from every frame
   * to once, up front, because motion-v needs a plain number rather than an
   * expression it can defer to the cascade.
   */
  it('reads a custom property set on an ancestor, the way CSS inheritance would', () => {
    const shell = document.createElement('div')
    shell.style.setProperty('--panel-motion-x', '-12px')
    const column = document.createElement('div')
    shell.append(column)
    document.body.append(shell)
    expect(panelMotionX(column)).toBe(-12)
    shell.remove()
  })

  it('falls back to 12px for a value it cannot parse as a number', () => {
    const element = document.createElement('div')
    element.style.setProperty('--panel-motion-x', 'not-a-length')
    document.body.append(element)
    expect(panelMotionX(element)).toBe(12)
    element.remove()
  })
})
