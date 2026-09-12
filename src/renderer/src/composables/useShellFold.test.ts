// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useShellFold } from './useShellFold'
import { PANEL_MOTION_WATCHDOG_MS } from '../lib/shell/panelMotion'
import type { PanelEdge } from '../types'
import type { ShellComposition } from '../lib/shell/composition'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Reflect.deleteProperty(document, 'hidden')
})

/** A box with a width, which jsdom lays nothing out to give it. */
function sized<T extends HTMLElement>(element: T, width: number): T {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 })
  })
  return element
}

function harness(options: { reduced?: boolean; hidden?: boolean; width?: number } = {}) {
  const media = new EventTarget() as MediaQueryList
  Object.defineProperty(media, 'matches', { configurable: true, value: options.reduced ?? false })
  vi.stubGlobal('matchMedia', () => media)
  if (options.hidden !== undefined)
    Object.defineProperty(document, 'hidden', { configurable: true, value: options.hidden })

  const animations: {
    keyframes: Keyframe[]
    timing: KeyframeAnimationOptions
    finish: () => void
    cancel: ReturnType<typeof vi.fn>
  }[] = []
  const shell = sized(document.createElement('div'), options.width ?? 1001)
  shell.style.columnGap = '8px'
  shell.style.padding = '8px'
  shell.style.borderRadius = '12px'
  Object.defineProperty(shell, 'animate', {
    configurable: true,
    value: (keyframes: Keyframe[], timing: KeyframeAnimationOptions) => {
      let finish!: () => void
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const cancel = vi.fn()
      animations.push({ keyframes, timing, finish, cancel })
      return { finished, cancel }
    }
  })
  document.body.append(shell)

  const state = { edge: 'right' as PanelEdge, remaining: 'pages' as ShellComposition, shell }
  let fold!: ReturnType<typeof useShellFold>
  const wrapper = mount(
    defineComponent({
      setup: () => {
        fold = useShellFold({
          shell: () => state.shell,
          edge: () => state.edge,
          remaining: () => state.remaining
        })
        return () => h('div')
      }
    })
  )
  const column = (width: number): HTMLElement => sized(document.createElement('div'), width)
  return {
    animations,
    shell,
    state,
    media,
    column,
    wrapper,
    get fold() {
      return fold
    }
  }
}

/** The microtask the batched fold is measured on, plus the promise plumbing. */
const settled = (): Promise<void> => Promise.resolve().then(() => undefined)

describe('useShellFold', () => {
  it('folds the shell down to what the leaving column leaves behind', async () => {
    const test = harness()
    test.state.remaining = 'mine'
    expect(test.fold.hold(test.column(555))).toBeInstanceOf(Promise)
    await settled()
    expect(test.animations).toHaveLength(1)
    expect(test.animations[0]!.keyframes).toEqual([
      { clipPath: 'inset(0px 0px 0px 0px round 12px)' },
      { clipPath: 'inset(0px 0px 0px calc(100% - 438px) round 12px)' }
    ])
    expect(test.animations[0]!.timing).toEqual({
      duration: 250,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      fill: 'both'
    })
    test.wrapper.unmount()
  })

  it('mirrors the fold onto the free side of a left-docked shell', async () => {
    const test = harness()
    test.state.edge = 'left'
    test.state.remaining = 'mine'
    void test.fold.hold(test.column(555))
    await settled()
    expect(test.animations[0]!.keyframes[1]).toEqual({
      clipPath: 'inset(0px calc(100% - 438px) 0px 0px round 12px)'
    })
    test.wrapper.unmount()
  })

  /*
   * Every column leaving in one change is one fold, not one each: the ground
   * they stand on is a single surface, and three animations racing on it would
   * be three answers to the question of how wide it is.
   */
  it('is ONE fold however many columns leave in the same change', async () => {
    const test = harness()
    test.state.remaining = 'rail'
    const first = test.fold.hold(test.column(555))
    const second = test.fold.hold(test.column(38))
    const third = test.fold.hold(test.column(348))
    expect(second).toBe(first)
    expect(third).toBe(first)
    await settled()
    expect(test.animations).toHaveLength(1)
    expect(test.animations[0]!.keyframes[1]).toEqual({
      clipPath: 'inset(0px 0px 0px calc(100% - 20px) round 12px)'
    })
    test.wrapper.unmount()
  })

  it('reports the fold as the leave the shrink waits on, and not before it ends', async () => {
    const test = harness()
    let folded = false
    void test.fold.hold(test.column(555))!.then(() => {
      folded = true
    })
    await settled()
    expect(folded).toBe(false)
    test.animations[0]!.finish()
    await settled()
    expect(folded).toBe(true)
    expect(test.animations[0]!.cancel).toHaveBeenCalledOnce()
    expect(test.shell.style.clipPath).toBe('inset(0px 0px 0px calc(100% - 438px) round 12px)')
    test.wrapper.unmount()
  })

  /*
   * #266's rule, on the surface that now carries the motion: an occluded window
   * freezes Chromium's document timeline, so the fold lands on the compositor
   * and never reports itself. A leave that cannot report must still end.
   */
  it('releases a fold whose animation never reports finishing (#266)', async () => {
    vi.useFakeTimers()
    const test = harness()
    let folded = false
    void test.fold.hold(test.column(555))!.then(() => {
      folded = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(test.animations).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(PANEL_MOTION_WATCHDOG_MS)
    expect(folded).toBe(true)
    expect(test.animations[0]!.cancel).toHaveBeenCalledOnce()
    test.wrapper.unmount()
  })

  it('ends a running fold the moment the window is occluded (#266)', async () => {
    const test = harness()
    let folded = false
    void test.fold.hold(test.column(555))!.then(() => {
      folded = true
    })
    await settled()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await settled()
    expect(folded).toBe(true)
    test.wrapper.unmount()
  })

  it('ends a running fold when reduced motion is asked for mid-way', async () => {
    const test = harness()
    let folded = false
    void test.fold.hold(test.column(555))!.then(() => {
      folded = true
    })
    await settled()
    Object.defineProperty(test.media, 'matches', { configurable: true, value: true })
    test.media.dispatchEvent(new Event('change'))
    await settled()
    expect(folded).toBe(true)
    test.wrapper.unmount()
  })

  it('never starts a fold a hidden window could not advance, and waits on nothing', async () => {
    const test = harness({ hidden: true })
    expect(test.fold.hold(test.column(555))).toBeNull()
    await settled()
    expect(test.animations).toHaveLength(0)
    expect(test.shell.style.clipPath).toBe('')
    test.wrapper.unmount()
  })

  it('collapses to the instant state change when reduced motion is already asked for', async () => {
    const test = harness({ reduced: true })
    expect(test.fold.hold(test.column(555))).toBeNull()
    await settled()
    expect(test.animations).toHaveLength(0)
    test.wrapper.unmount()
  })

  /*
   * The open direction. Main grows the window first, so the shell's box is
   * already the wide one: the ground has to start clipped to the footprint it
   * had before, or the pixels the window just added are painted the moment they
   * arrive — which is the flicker, with the sign reversed.
   */
  it('unfolds from the footprint the shell had before main grew the window', async () => {
    const test = harness({ width: 32 })
    test.fold.settle(false)
    test.state.shell = sized(test.shell, 645)
    test.fold.settle(false)
    expect(test.animations).toHaveLength(1)
    expect(test.animations[0]!.keyframes).toEqual([
      { clipPath: 'inset(0px 0px 0px calc(100% - 32px) round 12px)' },
      { clipPath: 'inset(0px 0px 0px 0px round 12px)' }
    ])
    test.animations[0]!.finish()
    await settled()
    expect(test.shell.style.clipPath).toBe('')
    test.wrapper.unmount()
  })

  /*
   * The collapsed shell paints the design's 20px rail inside the 32px window
   * the platform will not go below, so `painted` is smaller than the box around
   * it for as long as the panel stays shut. Every layout request settles — a
   * refused one, a redock, the moment one starts — and reading that standing
   * gap as room to unfold into would animate on all of them, and lose the very
   * footprint the next opening needs.
   */
  it('leaves the footprint alone when a request settles without moving the window', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'rail'
    void test.fold.hold(test.column(555))
    void test.fold.hold(test.column(38))
    await settled()
    test.animations[0]!.finish()
    await settled()
    sized(test.shell, 32)
    test.fold.settle(false)
    test.fold.settle(false)
    test.fold.settle(false)
    expect(test.animations).toHaveLength(1)
    sized(test.shell, 645)
    test.fold.settle(false)
    expect(test.animations[1]!.keyframes[0]).toEqual({
      clipPath: 'inset(0px 0px 0px calc(100% - 20px) round 12px)'
    })
    test.wrapper.unmount()
  })

  it('unfolds from the rail the fold ended on, not from the window around it', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'rail'
    void test.fold.hold(test.column(555))
    void test.fold.hold(test.column(38))
    await settled()
    test.animations[0]!.finish()
    await settled()
    // The window has caught up with the fold: the strip IS the window now, so
    // the clip has nothing left to do.
    sized(test.shell, 32)
    test.fold.settle(false)
    expect(test.shell.style.clipPath).toBe('')
    sized(test.shell, 645)
    test.fold.settle(false)
    expect(test.animations[1]!.keyframes[0]).toEqual({
      clipPath: 'inset(0px 0px 0px calc(100% - 20px) round 12px)'
    })
    test.wrapper.unmount()
  })

  /*
   * The swap: main reserves the UNION of both compositions before either column
   * moves, so the window is briefly wider than anything presentation asked for.
   * Unfolding into that reservation would paint the very pixels the fold is
   * about to take back.
   */
  it('keeps the previous footprint painted while main holds a reservation', async () => {
    const test = harness({ width: 645 })
    test.fold.settle(false)
    sized(test.shell, 1001)
    test.fold.settle(true)
    expect(test.animations).toHaveLength(0)
    expect(test.shell.style.clipPath).toBe('inset(0px 0px 0px calc(100% - 645px) round 12px)')
    test.state.remaining = 'mine'
    void test.fold.hold(test.column(555))
    await settled()
    expect(test.animations[0]!.keyframes).toEqual([
      { clipPath: 'inset(0px 0px 0px calc(100% - 645px) round 12px)' },
      { clipPath: 'inset(0px 0px 0px calc(100% - 438px) round 12px)' }
    ])
    test.wrapper.unmount()
  })

  it('releases a fold still running when the shell goes away', async () => {
    const test = harness()
    let folded = false
    void test.fold.hold(test.column(555))!.then(() => {
      folded = true
    })
    await settled()
    test.wrapper.unmount()
    await settled()
    expect(folded).toBe(true)
  })
})
