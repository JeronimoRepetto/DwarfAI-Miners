// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DOMKeyframesDefinition } from 'motion-v'
import { getDefaultTransition } from 'motion-v'
import { useShellFold } from './useShellFold'
import { panelLeaveBoundMs } from '../lib/shell/panelMotion'
import { motionBoundMs, type MotionTransition } from '../lib/shell/motionTiming'
import type { MotionAnimate } from '../lib/shell/boundedMotion'
import type { PanelEdge } from '../types'
import type { ShellComposition } from '../lib/shell/composition'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Reflect.deleteProperty(document, 'hidden')
})

/** A box with a width, which jsdom lays nothing out to give it. */
function sized<T extends HTMLElement>(element: T, width: number): T {
  return placed(element, 0, width)
}

/*
 * AMENDED for #464 (`sized` is this with a left of 0). Where a column STANDS is
 * now part of the fold's answer and not only how wide it is: the rail is the
 * free-most column of every open composition, so a strip of the right width can
 * still be a strip the rail is outside of.
 */
function placed<T extends HTMLElement>(element: T, left: number, width: number): T {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      width,
      height: 0,
      top: 0,
      left,
      right: left + width,
      bottom: 0,
      x: left,
      y: 0
    })
  })
  return element
}

/**
 * A hand-written stand-in for motion-v's own `animate()` — AMENDED for #566
 * (was: stubbing `element.animate`, WAAPI's own entry point, which the runner
 * no longer calls). One engine drives both the ground and the rail, so runs
 * are recorded into one list and the harness filters by element — preserving
 * the two per-element lists (`animations`, `railAnimations`) every case below
 * already indexes into.
 *
 * AMENDED again for #566: no `timing` argument any more — the runner passes
 * `animate()` no transition at all now, so a fake that recorded one would be
 * recording something the real call site never sends.
 *
 * AMENDED again for #464 (correction to T2): `transition` is back, recorded
 * (possibly `undefined`) rather than asserted on — the fold's own clip run
 * never passes one (its default IS what the rail is meant to share), but the
 * rail's carry now does.
 */
function fakeEngine() {
  const runs: {
    element: Element
    keyframes: DOMKeyframesDefinition
    transition: MotionTransition | undefined
    finish: () => void
    cancel: ReturnType<typeof vi.fn>
  }[] = []
  const animate: MotionAnimate = (element, keyframes, transition) => {
    let resolve!: () => void
    const finished = new Promise<void>((done) => {
      resolve = done
    })
    const cancel = vi.fn()
    runs.push({ element, keyframes, transition, finish: resolve, cancel })
    return {
      cancel,
      then: (onResolve: () => void, onReject?: () => void) => finished.then(onResolve, onReject)
    }
  }
  return { animate, runs }
}

function harness(options: { reduced?: boolean; hidden?: boolean; width?: number } = {}) {
  const media = new EventTarget() as MediaQueryList
  Object.defineProperty(media, 'matches', { configurable: true, value: options.reduced ?? false })
  vi.stubGlobal('matchMedia', () => media)
  if (options.hidden !== undefined)
    Object.defineProperty(document, 'hidden', { configurable: true, value: options.hidden })

  const shell = sized(document.createElement('div'), options.width ?? 1001)
  shell.style.columnGap = '8px'
  shell.style.padding = '8px'
  shell.style.borderRadius = '12px'
  // `still()` reads this only as the app's proxy for "a real Chromium
  // window" (motion-v needs no such method to run) — jsdom has none, so every
  // case that wants the motion path stubs one in, exactly as before.
  Object.defineProperty(shell, 'animate', { configurable: true, value: () => undefined })
  document.body.append(shell)

  /*
   * AMENDED for #464, optional and defaulted so every case above is untouched.
   * The rail travels with the fold now — it stands at the shell's FREE edge
   * while a page is open, which is the end of the shell the fold clips away —
   * so the composable has to be handed it, and its own animation is recorded
   * apart from the ground's rather than counted among them.
   */
  const rail = placed(document.createElement('div'), 8, 20)
  Object.defineProperty(rail, 'animate', { configurable: true, value: () => undefined })
  shell.append(rail)

  const engine = fakeEngine()
  const state = {
    edge: 'right' as PanelEdge,
    remaining: 'pages' as ShellComposition,
    shell,
    rail: rail as HTMLElement | null,
    /*
     * ADDED for #566 T5b, both `null` by default so every case above this
     * one is untouched: `mountedColumns` drops a `null` entry the same way it
     * always has for the rail. A case that wants the mine column's own
     * departure or arrival to carry the secondary panel and the navigation
     * stack too sets these to real elements first.
     */
    secondary: null as HTMLElement | null,
    nav: null as HTMLElement | null,
    /*
     * ADDED for #585 round 2, `false` by default so every case above is
     * untouched: whether main is still answering a layout request. The
     * renderer's own `resize` can land a whole tick before Vue mounts the
     * columns that same request brings, and an unfold measured there reveals
     * the ground with nothing on it.
     */
    applying: false
  }
  let fold!: ReturnType<typeof useShellFold>
  const wrapper = mount(
    defineComponent({
      setup: () => {
        fold = useShellFold({
          shell: () => state.shell,
          edge: () => state.edge,
          remaining: () => state.remaining,
          rail: () => state.rail,
          carried: () => [state.secondary, state.nav],
          // ADDED for #585 round 3: the navigation strip is the wall a drawer
          // goes behind, and a wall does not move out of the way of its own
          // drawer. Every case above is untouched: `state.nav` is `null`
          // there, which is a shell with no strip to name.
          strip: () => state.nav,
          applying: () => state.applying,
          engine: engine.animate
        })
        return () => h('div')
      }
    })
  )
  const column = (width: number): HTMLElement => sized(document.createElement('div'), width)
  return {
    get animations() {
      return engine.runs.filter((run) => run.element === state.shell)
    },
    get railAnimations() {
      return engine.runs.filter((run) => run.element === state.rail)
    },
    get secondaryAnimations() {
      return engine.runs.filter((run) => run.element === state.secondary)
    },
    get navAnimations() {
      return engine.runs.filter((run) => run.element === state.nav)
    },
    /** ADDED for #566 T5b: the leaving or entering column's own runs, by element, rather than a fixed name. */
    animationsFor(element: HTMLElement) {
      return engine.runs.filter((run) => run.element === element)
    },
    shell,
    rail,
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

/**
 * ADDED for #566 T5b. A carried column, placed and given the SAME `.animate`
 * stub `rail` gets in `harness()`: `mountedColumns` drops anything `still()`
 * reads as unable to run Web Animations, exactly the proxy for "a real
 * Chromium window" the rest of this file already relies on — a leaving or
 * entering column never needs this (`carrySelf` runs through the injected
 * fake engine, never `element.animate`, and nothing here gates it on
 * `still()`), but a column asked to stand FREE of one does.
 */
function carriedColumn(left: number, width: number): HTMLElement {
  const element = placed(document.createElement('div'), left, width)
  Object.defineProperty(element, 'animate', { configurable: true, value: () => undefined })
  return element
}

/** The two `clip-path` strings a fold's keyframes carry, cast once rather than at every call site. */
function clipFrames(keyframes: DOMKeyframesDefinition): [string, string] {
  return keyframes.clipPath as [string, string]
}

/**
 * The two transforms a rail carry's keyframes carry, cast once for the same
 * reason — AMENDED for #585, was `xFrames` reading motion-v's `x` shortcut.
 */
function transformFrames(keyframes: DOMKeyframesDefinition): [string, string] {
  return keyframes.transform as [string, string]
}

/**
 * A carried column's travel as the keyframes it is actually handed — ADDED
 * for #585, where the travel stopped being motion-v's `x` shortcut (a JS-
 * driven value, on its own clock) and became the `transform` string WAAPI
 * accelerates, so that a column's translate and its clip are one timeline.
 * Written out here rather than imported from `shellFold.ts`, whose own test
 * pins these exact strings: a composable asserted against its own builder
 * would agree with it however wrong both were.
 */
function carries(from: number, to: number): DOMKeyframesDefinition {
  return { transform: [`translateX(${from}px)`, `translateX(${to}px)`] }
}

/**
 * How many times this shell's own computed style is resolved.
 *
 * The count is the subject and not an implementation detail (#396): resolving
 * a style is what forces the browser to recalculate one, and the read that
 * used to land immediately after `clip-path` was written forced it on an
 * element whose box had just been invalidated. Filtered to the shell so that
 * anything else in the environment reading a style cannot be mistaken for the
 * fold reading its radius.
 */
function styleReads(shell: HTMLElement) {
  const spy = vi.spyOn(window, 'getComputedStyle')
  return {
    get count(): number {
      return spy.mock.calls.filter(([element]) => element === shell).length
    },
    forget: (): void => void spy.mockClear(),
    restore: (): void => void spy.mockRestore()
  }
}

/*
 * AMENDED for #464 throughout (was: `hold()` answering one promise, awaited
 * directly). A leaving column now waits on TWO moments that used to be one —
 * the fold ending, which is what the shrink waits for, and the window having
 * caught up, which is what may finally unmount it — so every case that awaited
 * the answer awaits `.folded` instead. The batch is still one object shared by
 * every column of a change, so the identity the cases below assert is unchanged.
 */
describe('useShellFold', () => {
  it('folds the shell down to what the leaving column leaves behind', async () => {
    const test = harness()
    test.state.remaining = 'mine'
    expect(test.fold.hold(test.column(555))!.folded).toBeInstanceOf(Promise)
    await settled()
    expect(test.animations).toHaveLength(1)
    expect(test.animations[0]!.keyframes).toEqual({
      clipPath: [
        'inset(0px 0px 0px 0px round 12px)',
        'inset(0px 0px 0px calc(100% - 438px) round 12px)'
      ]
    })
    test.wrapper.unmount()
  })

  it('mirrors the fold onto the free side of a left-docked shell', async () => {
    const test = harness()
    test.state.edge = 'left'
    test.state.remaining = 'mine'
    void test.fold.hold(test.column(555))
    await settled()
    expect(clipFrames(test.animations[0]!.keyframes)[1]).toBe(
      'inset(0px calc(100% - 438px) 0px 0px round 12px)'
    )
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
    expect(clipFrames(test.animations[0]!.keyframes)[1]).toBe(
      'inset(0px 0px 0px calc(100% - 20px) round 12px)'
    )
    test.wrapper.unmount()
  })

  it('reports the fold as the leave the shrink waits on, and not before it ends', async () => {
    const test = harness()
    let folded = false
    void test.fold.hold(test.column(555))!.folded.then(() => {
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
    void test.fold.hold(test.column(555))!.folded.then(() => {
      folded = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(test.animations).toHaveLength(1)
    // The fold's own run is `clipPath`, never a transformProp — motion-v's
    // default for it is the flat 0.3s ease regardless of the strip widths
    // (`motionTiming.ts`), so the derived watchdog is asked of the exact
    // keyframes this run is animating rather than restated as a literal.
    await vi.advanceTimersByTimeAsync(motionBoundMs(test.animations[0]!.keyframes))
    expect(folded).toBe(true)
    expect(test.animations[0]!.cancel).toHaveBeenCalledOnce()
    test.wrapper.unmount()
  })

  it('ends a running fold the moment the window is occluded (#266)', async () => {
    const test = harness()
    let folded = false
    void test.fold.hold(test.column(555))!.folded.then(() => {
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
    void test.fold.hold(test.column(555))!.folded.then(() => {
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
    // AMENDED for #585: the unfold waits one microtask for the columns of
    // this change to register, so what it starts is observed after it.
    await settled()
    expect(test.animations).toHaveLength(1)
    expect(test.animations[0]!.keyframes).toEqual({
      clipPath: [
        'inset(0px 0px 0px calc(100% - 32px) round 12px)',
        'inset(0px 0px 0px 0px round 12px)'
      ]
    })
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
    // AMENDED for #585: the unfold waits one microtask for the columns of
    // this change to register, so what it starts is observed after it.
    await settled()
    expect(clipFrames(test.animations[1]!.keyframes)[0]).toBe(
      'inset(0px 0px 0px calc(100% - 20px) round 12px)'
    )
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
    // AMENDED for #585: the unfold waits one microtask for the columns of
    // this change to register, so what it starts is observed after it.
    await settled()
    expect(clipFrames(test.animations[1]!.keyframes)[0]).toBe(
      'inset(0px 0px 0px calc(100% - 20px) round 12px)'
    )
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
    expect(test.animations[0]!.keyframes).toEqual({
      clipPath: [
        'inset(0px 0px 0px calc(100% - 645px) round 12px)',
        'inset(0px 0px 0px calc(100% - 438px) round 12px)'
      ]
    })
    test.wrapper.unmount()
  })

  /*
   * ADDED for #396. The radius is the ground's own `border-radius`, read off
   * the element so the strip a fold ends on has the rail's shape — and reading
   * it resolves a style. A fold resolved two: one to measure the row it is
   * folding, and a second inside the run for the radius, in the same microtask
   * and against the same unchanged element.
   */
  /*
   * ADDED for #396, pinning behaviour the three collapsed tails used to carry
   * by their ORDER alone: the pinned case was tested before the growing one, so
   * a fold whose window then caught up with it WIDER than the box the fold
   * started from never unfolded. It still must not. `painted` is a footprint
   * the change has already superseded, and sweeping the ground open from it
   * would animate across pixels the fold never covered.
   */
  it('does not unfold from a fold’s footprint when the window catches up wider than it was', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'mine'
    test.fold.settle(false)
    void test.fold.hold(test.column(555))
    await settled()
    test.animations[0]!.finish()
    await settled()
    expect(test.shell.style.clipPath).toBe('inset(0px 0px 0px calc(100% - 82px) round 12px)')
    sized(test.shell, 1001)
    test.fold.settle(false)
    expect(test.animations).toHaveLength(1)
    expect(test.shell.style.clipPath).toBe('')
    test.wrapper.unmount()
  })

  it('resolves the shell’s style once for a whole fold, not once per step of it', async () => {
    const test = harness()
    test.state.remaining = 'mine'
    const reads = styleReads(test.shell)
    void test.fold.hold(test.column(555))
    await settled()
    expect(test.animations).toHaveLength(1)
    expect(reads.count).toBe(1)
    reads.restore()
    test.wrapper.unmount()
  })

  /*
   * ADDED for #396. The unfold's second read was the expensive one: it came
   * after `apply` had written the starting clip, so the style it asked for
   * could not be served from what the browser already had.
   */
  it('resolves the shell’s style once for an unfold, and not at all for a settle that stays whole', async () => {
    const test = harness({ width: 32 })
    const reads = styleReads(test.shell)
    test.fold.settle(false)
    test.fold.settle(false)
    expect(test.animations).toHaveLength(0)
    expect(reads.count).toBe(0)
    reads.forget()
    test.state.shell = sized(test.shell, 645)
    test.fold.settle(false)
    // AMENDED for #585: the unfold waits one microtask for the columns of
    // this change to register, so what it starts is observed after it.
    await settled()
    expect(test.animations).toHaveLength(1)
    expect(reads.count).toBe(1)
    reads.restore()
    test.wrapper.unmount()
  })

  /*
   * ADDED for #464. The strip the fold ends on is held against the DOCKED edge
   * and the rail stands at the free one, so a fold that only narrowed the ground
   * clipped the rail away and swept a padding and a gap past the panel that was
   * actually leaving. The rail travels to where the row is about to put it
   * instead — which is the only way the rule #388 exists for survives, because a
   * resize takes its pixels off an EDGE and the rail is painted inside the band
   * that is about to go.
   */
  it('carries the rail into the strip the fold ends on, and sets it down when the window catches up', async () => {
    const test = harness()
    test.state.remaining = 'mine'
    void test.fold.hold(test.column(555))
    await settled()
    expect(test.railAnimations[0]!.keyframes).toEqual(carries(0, 563))
    test.animations[0]!.finish()
    await settled()
    // Written rather than left to the engine: motion-v writes straight into
    // `element.style` too, and `place` still has to own the property `stop()`
    // would otherwise leave the engine's own last frame sitting on — the rail
    // would snap back to the free edge for the frame between the fold ending
    // and main resizing the window around it.
    expect(test.rail.style.transform).toBe('translateX(563px)')
    sized(test.shell, 438)
    test.fold.settle(false)
    // The row has caught up with the fold, so the travel is the layout's own
    // again and holding the transform would push the rail out of the window.
    expect(test.rail.style.transform).toBe('')
    test.wrapper.unmount()
  })

  /*
   * ADDED for #464 (correction to T2). The fold is ONE motion: without a
   * shared transition, `x` (the rail's own transformProp) picks up the
   * underdamped spring while `clipPath` (never a transformProp) gets the
   * flat 0.3s ease, and a 563px rail carry under that spring can take
   * anywhere from 400ms to 650ms — well past the clip's fixed 300ms, so the
   * rail would still be travelling inside the band the clip has already cut
   * away when the shrink goes out.
   */
  it('carries the rail on the SAME transition the clip run gets, never its own default spring', async () => {
    const test = harness()
    test.state.remaining = 'mine'
    void test.fold.hold(test.column(555))
    await settled()
    expect(test.railAnimations[0]!.keyframes).toEqual(carries(0, 563))
    // The clip run's own transition is motion-dom's real answer for
    // `clipPath` — never asserted as a literal here, so a change to
    // motion-dom's own default would move both sides of this assertion
    // together rather than only the rail's.
    const clipTransition = getDefaultTransition('clipPath', {
      keyframes: clipFrames(test.animations[0]!.keyframes) as unknown as number[]
    })
    expect(test.animations[0]!.transition).toBeUndefined()
    expect(test.railAnimations[0]!.transition).toEqual(clipTransition)
    test.wrapper.unmount()
  })

  it('mirrors the rail’s travel onto the free side of a left-docked shell', async () => {
    const test = harness()
    test.state.edge = 'left'
    test.state.remaining = 'mine'
    // The docked edge is the shell's left, so the free edge the rail stands at
    // is the other end of the same row.
    placed(test.rail, 973, 20)
    void test.fold.hold(test.column(555))
    await settled()
    expect(transformFrames(test.railAnimations[0]!.keyframes)[1]).toBe('translateX(-563px)')
    test.wrapper.unmount()
  })

  /*
   * ADDED for #464. The fold ending and the column being let go used to be the
   * same turn: `done()` unmounted `.shell-secondary`, which is `flex: 1`, so the
   * row repacked while main had not been asked to resize yet — and every frame
   * until its reply landed was the strip painted over bare ground. The shrink
   * still waits on the fold and only the fold, or the two would wait on each
   * other; what the column waits on is the window.
   */
  it('holds a leaving column past the fold, until the window has caught up with it', async () => {
    const test = harness()
    test.fold.settle(false)
    test.state.remaining = 'mine'
    const leaving = test.fold.hold(test.column(555))!
    let folded = false
    let released = false
    void leaving.folded.then(() => {
      folded = true
    })
    void leaving.released.then(() => {
      released = true
    })
    await settled()
    test.animations[0]!.finish()
    await settled()
    // The fold is over, so main may be asked to resize; the column that leaves
    // is what is standing in the window until it has.
    expect(folded).toBe(true)
    expect(released).toBe(false)
    test.fold.settle(false)
    await settled()
    expect(released).toBe(false)
    sized(test.shell, 438)
    test.fold.settle(false)
    await settled()
    expect(released).toBe(true)
    test.wrapper.unmount()
  })

  /*
   * The same bound the layout queue gives a leave (#266): a window that never
   * answers must not leave the row standing at a width nothing will correct.
   */
  it('lets a held column go one bound after a fold main never answers', async () => {
    vi.useFakeTimers()
    const test = harness()
    test.fold.settle(false)
    test.state.remaining = 'mine'
    const leaving = test.fold.hold(test.column(555))!
    let released = false
    void leaving.released.then(() => {
      released = true
    })
    await vi.advanceTimersByTimeAsync(0)
    test.animations[0]!.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(released).toBe(false)
    await vi.advanceTimersByTimeAsync(panelLeaveBoundMs())
    expect(released).toBe(true)
    test.wrapper.unmount()
  })

  it('lets a held column go when the shell goes away under it', async () => {
    const test = harness()
    const leaving = test.fold.hold(test.column(555))!
    let released = false
    void leaving.released.then(() => {
      released = true
    })
    await settled()
    test.wrapper.unmount()
    await settled()
    expect(released).toBe(true)
  })

  it('carries nothing when the row leaves the rail where it stands', async () => {
    const test = harness({ width: 0 })
    sized(test.rail, 0)
    test.state.remaining = 'mine'
    void test.fold.hold(test.column(0))
    await settled()
    expect(test.railAnimations).toHaveLength(0)
    test.wrapper.unmount()
  })

  /*
   * The rail is reached through the component that draws it, so it can honestly
   * be absent — and a fold that threw over that would take the shrink down with
   * it. The ground still folds; only the travel is lost.
   */
  it('folds the ground without the rail when there is none to carry', async () => {
    const test = harness()
    test.state.rail = null
    test.state.remaining = 'mine'
    void test.fold.hold(test.column(555))
    await settled()
    expect(test.railAnimations).toHaveLength(0)
    expect(clipFrames(test.animations[0]!.keyframes)[1]).toBe(
      'inset(0px 0px 0px calc(100% - 438px) round 12px)'
    )
    test.wrapper.unmount()
  })

  /*
   * ADDED for #464. A settle is main reporting the layout it applied, and the
   * viewport is not obliged to have caught up with it: the reply crosses one IPC
   * hop while the window's own resize reaches the renderer on its own schedule.
   * Unclipping on the report alone paints the whole ground back inside a window
   * still holding the width the fold started from — the very frame the fold
   * exists to remove.
   */
  it('keeps the fold’s clip while the viewport still reports the box the fold started from', async () => {
    const test = harness()
    test.fold.settle(false)
    test.state.remaining = 'mine'
    void test.fold.hold(test.column(555))
    await settled()
    test.animations[0]!.finish()
    await settled()
    const folded = 'inset(0px 0px 0px calc(100% - 438px) round 12px)'
    expect(test.shell.style.clipPath).toBe(folded)
    test.fold.settle(false)
    expect(test.shell.style.clipPath).toBe(folded)
    expect(test.rail.style.transform).toBe('translateX(563px)')
    sized(test.shell, 438)
    test.fold.settle(false)
    expect(test.shell.style.clipPath).toBe('')
    expect(test.rail.style.transform).toBe('')
    test.wrapper.unmount()
  })

  it('lets the window’s own resize end a fold main has not reported yet', async () => {
    const test = harness()
    test.fold.settle(false)
    test.state.remaining = 'mine'
    void test.fold.hold(test.column(555))
    await settled()
    test.animations[0]!.finish()
    await settled()
    sized(test.shell, 438)
    window.dispatchEvent(new Event('resize'))
    expect(test.shell.style.clipPath).toBe('')
    expect(test.rail.style.transform).toBe('')
    test.wrapper.unmount()
  })

  /*
   * ADDED for #464. The open direction has the same seam with its sign reversed:
   * main grows the window and the row repacks the rail out to the new free edge,
   * which is outside the footprint the ground unfolds FROM, so the rail vanished
   * until the sweep reached it. It starts where it was and comes back with the
   * ground.
   */
  it('returns the rail from the footprint it had when the shell unfolds', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'rail'
    void test.fold.hold(test.column(555))
    void test.fold.hold(test.column(38))
    await settled()
    test.animations[0]!.finish()
    await settled()
    sized(test.shell, 32)
    test.fold.settle(false)
    sized(test.shell, 645)
    test.fold.settle(false)
    // AMENDED for #585: the unfold waits one microtask for the columns of
    // this change to register, so what it starts is observed after it.
    await settled()
    // The rail rested against the docked edge; the row has just put it back at
    // the free one, 617px away from where the unfold has to start.
    expect(test.railAnimations[1]!.keyframes).toEqual(carries(617, 0))
    expect(test.rail.style.transform).toBe('translateX(617px)')
    test.animations[1]!.finish()
    await settled()
    expect(test.rail.style.transform).toBe('')
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585. The unfold waits a microtask for the rest of its change,
   * and a microtask cannot be cancelled: the component can go away inside it.
   * Starting the run anyway would animate an element this instance has just
   * stopped owning, on a runner it has already disposed — and nothing would
   * ever end it.
   */
  it('withdraws an unfold still waiting for its change when the shell goes away', async () => {
    const test = harness({ width: 645 })
    test.fold.settle(false)
    test.state.shell = sized(test.shell, 1001)
    test.fold.settle(false)
    test.wrapper.unmount()
    await settled()
    expect(test.animations).toHaveLength(0)
  })

  it('releases a fold still running when the shell goes away', async () => {
    const test = harness()
    let folded = false
    void test.fold.hold(test.column(555))!.folded.then(() => {
      folded = true
    })
    await settled()
    test.wrapper.unmount()
    await settled()
    expect(folded).toBe(true)
  })

  /*
   * ADDED for #464 (correction to T2): `panelLeaveBoundMs()` covers the
   * `overrun` timer above — one constant, not a `Math.max` derived per fold —
   * and this is WHY, in code rather than by coincidence: every run a fold
   * ever starts (clip, rail) now shares the clip's own transition, and a
   * non-spring transition's duration is `transition.duration * 1000`
   * regardless of the keyframes it is handed (`motionTiming.ts`), so the
   * fold's own bound can never exceed the clip's, however far the rail
   * travels. `panelLeaveBoundMs()` already covers the clip's own bound (it is
   * derived from `panelKeyframes`' fixed 12px leave, which resolves to the
   * SAME 300ms/350ms as `clipPath`'s flat ease) — that relationship stays
   * asserted here rather than left to hold by accident.
   */
  it('panelLeaveBoundMs covers the fold’s own bound, because clip and rail now share one non-spring transition', () => {
    const clipTransition = getDefaultTransition('clipPath', {
      keyframes: ['a', 'b'] as unknown as number[]
    })
    expect(clipTransition.type).not.toBe('spring')
    const clipBound = motionBoundMs({ clipPath: ['a', 'b'] }, clipTransition)
    // However far the rail travels — 563px here, hundreds more elsewhere —
    // its bound under the SAME transition is the clip's own, never a
    // function of the distance.
    const railBound = motionBoundMs(carries(0, 563), clipTransition)
    expect(railBound).toBe(clipBound)
    expect(panelLeaveBoundMs()).toBeGreaterThanOrEqual(Math.max(clipBound, railBound))
  })
  /*
   * REMOVED for #488: three cases appended by #472/#474 that pinned the
   * `is-holding` class this composable used to write while a fold stood over a
   * held column. The class is gone — every open composition packs against the
   * docked edge at rest now, so a rule for the held frames restated the default
   * — and with it the only thing those three asserted. What they were really
   * about is above and was never theirs: the hold lifecycle they framed is
   * pinned by the three cases named "holds a leaving column past the fold, until
   * the window has caught up", "lets a held column go one bound after a fold
   * main never answers" and "lets a held column go when the shell goes away".
   * The packing itself is now pinned where it lives, in "App shell packing
   * (#488)" in App.test.ts.
   */
})

/*
 * ADDED for #566 T5b (user report: "closing the mine column animates the
 * left panel, then blinks"). Verified in code: the mine column docks beyond
 * the secondary panel and the navigation stack, so when IT is what leaves or
 * enters, they stand free of it the same way the rail always has — #464 only
 * ever carried the rail because it was the only column that ever was. The
 * cases below use the same book (`ROW` in `shellFold.test.ts`, restated here
 * as placements) so the numbers can be checked against that file's own
 * arithmetic: rail (8,20), secondary (36,555), navigation (599,38), mine
 * (645,348), an 8px gap and padding throughout.
 */
describe('useShellFold carrying more than the rail (#566 T5b)', () => {
  it('carries the secondary panel and the navigation stack, not only the rail, when the mine column closes beside them', async () => {
    const test = harness({ width: 1001 })
    test.state.remaining = 'pages'
    test.state.secondary = carriedColumn(36, 555)
    test.state.nav = carriedColumn(599, 38)
    const mine = test.column(348)
    void test.fold.hold(mine)
    await settled()
    // The mine column is the only one leaving, so every column free of it —
    // rail, secondary and the navigation stack alike — is carried by exactly
    // the SAME distance: its own width plus the gap beside it, the one thing
    // that changed.
    expect(test.railAnimations[0]!.keyframes).toEqual(carries(0, 356))
    expect(test.secondaryAnimations[0]!.keyframes).toEqual(carries(0, 356))
    expect(test.navAnimations[0]!.keyframes).toEqual(carries(0, 356))
    test.wrapper.unmount()
  })

  it('carries none of them for a secondary-panel leave, unchanged from #464', async () => {
    // The navigation stack and the mine column both dock BEYOND the
    // secondary panel, so neither is free of it — only the rail is, exactly
    // as before #566 T5b generalized the carry.
    const test = harness({ width: 1001 })
    test.state.remaining = 'mine'
    test.state.nav = carriedColumn(599, 38)
    void test.fold.hold(test.column(555))
    await settled()
    expect(test.railAnimations[0]!.keyframes).toEqual(carries(0, 563))
    expect(test.navAnimations).toHaveLength(0)
    test.wrapper.unmount()
  })

  /*
   * The leaving column's OWN motion — the maintainer's drawing: a drawer
   * sliding into a wall, not a panel fading beside one. It travels the SAME
   * distance the columns free of it do, on the SAME transition, clipped at
   * its own docked-side edge so it disappears there instead of painting over
   * the row beside it or past the window's own edge.
   *
   * AMENDED for #585: this case's own column is the MINE, which is the one
   * column the drawing does not describe — it docks BEYOND the navigation
   * strip, so the strip is on its FREE side and travels across it. What
   * covers it is that travel, not a travel of its own: its box stands exactly
   * where the row put it for the whole run (the interior inside it never
   * re-measures), and the clip on its free side is the strip's own near edge
   * sweeping over it. The drawer it used to assert is the case below, which
   * is where a leaving SECONDARY panel proves it unchanged.
   */
  it('uncovers the leaving mine column in place, on the same transition as the carries beside it', async () => {
    const test = harness({ width: 1001 })
    test.state.remaining = 'pages'
    test.state.secondary = carriedColumn(36, 555)
    test.state.nav = carriedColumn(599, 38)
    const mine = placed(test.column(348), 645, 348)
    void test.fold.hold(mine)
    await settled()
    const own = test.animationsFor(mine)
    expect(own).toHaveLength(1)
    // AMENDED for #585 round 3: the clip is measured to the edge of the column
    // COVERING it — the strip, one gap (8) away at rest and 356 nearer by the
    // end — rather than to the mine's own width stretched over the run. So it
    // starts a gap short of covering anything and ends having crossed exactly
    // the mine's 348.
    expect(own[0]!.keyframes).toEqual({
      clipPath: ['inset(0px 0px 0px -8px)', 'inset(0px 0px 0px 348px)']
    })
    // The clip's own transition — never `x`'s underdamped spring default —
    // the same rule `carry` already proved for the rail.
    expect(own[0]!.transition).toEqual(test.railAnimations[0]!.transition)
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585, the drawer half of the same rule and the case the one
   * above used to carry. The secondary panel stands on the FREE side of the
   * navigation strip, so that strip is the fixed mouth it is pushed back
   * into: it travels, and it is clipped at its own docked-side edge, exactly
   * as #566 T5b drew it.
   */
  it('slides a leaving secondary panel into the strip docked of it, clipped at that edge', async () => {
    const test = harness({ width: 1001 })
    test.state.remaining = 'mine'
    test.state.nav = carriedColumn(599, 38)
    const secondary = placed(test.column(555), 36, 555)
    void test.fold.hold(secondary)
    await settled()
    // AMENDED for #585 round 2: the drawer's mouth is the STRIP's near edge,
    // one gap docked of the column's own, so the clip retreats by the
    // column's width (555) and not by its whole travel (563) — the 8px
    // difference is the band of bare ground the probe measured between the
    // emerging panel and the strip it comes out of.
    expect(test.animationsFor(secondary)[0]!.keyframes).toEqual({
      ...carries(0, 563),
      clipPath: ['inset(0px 0px 0px 0px)', 'inset(0px 555px 0px 0px)']
    })
    test.wrapper.unmount()
  })

  it('mirrors every carry and the leaving column’s own clip onto a left-docked shell', async () => {
    const test = harness({ width: 1001 })
    test.state.edge = 'left'
    test.state.remaining = 'pages'
    // The docked edge is the shell's left on this dock, so the free edge
    // every carried column stands nearer is the other end of the same row —
    // placements mirrored from the right-docked book above.
    test.state.secondary = carriedColumn(410, 555)
    test.state.nav = carriedColumn(364, 38)
    placed(test.rail, 973, 20)
    const mine = placed(test.column(348), 8, 348)
    void test.fold.hold(mine)
    await settled()
    expect(test.railAnimations[0]!.keyframes).toEqual(carries(-0, -356))
    expect(test.secondaryAnimations[0]!.keyframes).toEqual(carries(-0, -356))
    expect(test.navAnimations[0]!.keyframes).toEqual(carries(-0, -356))
    // AMENDED for #585: the mine column is uncovered in place on either
    // dock, so it has no travel at all — and the free side it is clipped on
    // is the shell's RIGHT here, which is the mirror of the right-docked case
    // above rather than the same string. AMENDED again for round 3: measured
    // to the strip's edge, as above.
    expect(test.animationsFor(mine)[0]!.keyframes).toEqual({
      clipPath: ['inset(0px -8px 0px 0px)', 'inset(0px 348px 0px 0px)']
    })
    test.wrapper.unmount()
  })

  /*
   * The open direction, T5b's own reason to exist: main has already grown
   * the window and the row has already repacked around the entering column
   * by the time Vue ever mounts it, so `enter` pre-places it — translated and
   * clipped as if it had not arrived — and `settle`'s unfold carries it the
   * rest of the way on the SAME event that reveals the ground and carries
   * every other free column back.
   */
  it('pre-places an entering column, then carries it and everything free of it back on the unfold', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'pages'
    test.state.secondary = carriedColumn(36, 555)
    test.state.nav = carriedColumn(599, 38)
    // Establishes `box`/`painted`/every carried column's own rest position —
    // the footprint the mine column's own arrival is about to unfold from.
    test.fold.settle(false)
    const mine = placed(test.column(348), 645, 348)
    test.fold.enter(mine)
    // Pre-placed synchronously, before this module ever yields to the
    // browser — nothing here has awaited a microtask yet. AMENDED for #585:
    // pre-placing the mine column is a clip and nothing else, because being
    // uncovered in place is exactly not having a position of its own.
    expect(mine.style.transform).toBe('')
    expect(mine.style.clipPath).toBe('inset(0px 0px 0px 356px)')
    expect(test.animationsFor(mine)).toHaveLength(0)
    test.state.shell = sized(test.shell, 1001)
    test.fold.settle(false)
    // AMENDED for #585: the unfold is measured a microtask after the change
    // asks for it, so that every column of the same change has registered
    // first — see the case below, which is why.
    await settled()
    // AMENDED for #585 round 3: the reveal tracks the strip's own edge coming
    // back — 356 nearer than its rest at the start, so 348 of the mine (its
    // whole width) stands under the strip and the row beside it, and a gap
    // short of it once everything has landed.
    expect(test.animationsFor(mine)[0]!.keyframes).toEqual({
      clipPath: ['inset(0px 0px 0px 348px)', 'inset(0px 0px 0px -8px)']
    })
    expect(test.railAnimations[0]!.keyframes).toEqual(carries(356, 0))
    expect(test.secondaryAnimations[0]!.keyframes).toEqual(carries(356, 0))
    expect(test.navAnimations[0]!.keyframes).toEqual(carries(356, 0))
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585, from the real-window probe of the fixed build: opening a
   * mine beside an open page carried the rail and NOTHING else, leaving the
   * mine's own slot — 352px of it — as bare amber for the whole run.
   *
   * A carried column travels from the footprint it had when it last settled,
   * and a column that ARRIVED on the previous change had never recorded one:
   * the unfold that revealed it released it without remembering where it came
   * to rest, so the next fold found no footprint for it and left it standing
   * where the row had already repacked it. Every column the unfold touches
   * records its rest position now, arrivals included.
   */
  it('remembers where an entering column came to rest, so the next change carries it too', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'pages'
    test.fold.settle(false)
    // The secondary panel ARRIVES, and is carried by the unfold that reveals
    // the ground — the case above.
    const secondary = carriedColumn(36, 555)
    test.state.secondary = secondary
    // Main grows the window before Vue ever mounts an arriving column, so the
    // box `enter` reads it against is already the new one.
    test.state.shell = sized(test.shell, 1001)
    test.fold.enter(secondary)
    test.fold.settle(false)
    await settled()
    test.animations[0]!.finish()
    await settled()
    expect(test.secondaryAnimations).toHaveLength(1)
    // And now a mine opens beside it: the row repacks the secondary panel
    // 356px toward the free edge, so it has to come back from where it was.
    test.state.shell = sized(test.shell, 1357)
    const mine = placed(test.column(348), 1009, 348)
    test.fold.enter(mine)
    test.fold.settle(false)
    await settled()
    expect(test.secondaryAnimations).toHaveLength(2)
    expect(test.secondaryAnimations[1]!.keyframes).toEqual(carries(356, 0))
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585. The other side of the strip, in the open direction: an
   * entering secondary panel stands FREE of the navigation strip, so it is
   * pulled out from behind that strip's own edge — pre-placed with a travel
   * as well as a clip, and clipped at its DOCKED side, which is the mouth it
   * comes out of. Without this, "uncovered in place" would be free to
   * swallow every column rather than the one the strip stands beyond.
   */
  it('pre-places an entering secondary panel as a drawer, behind the strip docked of it', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'pages'
    test.state.nav = carriedColumn(599, 38)
    test.fold.settle(false)
    const secondary = placed(test.column(555), 36, 555)
    test.fold.enter(secondary)
    expect(secondary.style.transform).toBe('translateX(563px)')
    // AMENDED for #585 round 2: the mouth is the strip's near edge — see the
    // leave case above.
    expect(secondary.style.clipPath).toBe('inset(0px 555px 0px 0px)')
    test.state.shell = sized(test.shell, 1001)
    test.fold.settle(false)
    await settled()
    expect(test.animationsFor(secondary)[0]!.keyframes).toEqual({
      ...carries(563, 0),
      clipPath: ['inset(0px 555px 0px 0px)', 'inset(0px 0px 0px 0px)']
    })
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585. Which side a column is clipped on is asked of the row it
   * stands in, and the row is measured — so a column already pre-placed by an
   * EARLIER `enter` of the same change must not be read where its own
   * pre-placement has just put it. Opening the pages from the bare rail is
   * exactly that: the secondary panel registers first and is translated a
   * whole column's width toward the docked edge, and the navigation strip
   * registering second would otherwise see it standing docked of ITSELF and
   * call itself a drawer. The strip is the docked-most column of that row,
   * with the rail travelling out across it — uncovered in place, by the same
   * rule the mine column is.
   */
  it('reads a column already pre-placed by this change at its resting place, not its pre-placed one', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'pages'
    test.fold.settle(false)
    // `carriedColumn` rather than a bare one: `mountedColumns` drops anything
    // that cannot run Web Animations, and the row this case is about is the
    // one those two stand in.
    const secondary = carriedColumn(36, 555)
    const nav = carriedColumn(599, 38)
    test.state.secondary = secondary
    test.state.nav = nav
    test.fold.enter(secondary)
    test.fold.enter(nav)
    expect(secondary.style.transform).toBe('translateX(563px)')
    expect(nav.style.transform).toBe('')
    expect(nav.style.clipPath).toBe('inset(0px 0px 0px 46px)')
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585, from the same real-window probe. Opening was TWO
   * sequential 300ms runs: the ground unfolded ALONE — 936px of bare amber at
   * the peak, of a 956px window — and only once it had finished did the
   * content slide in.
   *
   * The cause is an ORDER, not a race. App.vue's `flush: 'post'` watch and a
   * `<Transition>`'s enter hook go into the same post-flush queue, and Vue
   * sorts it by id: the watch carries its component's own, the enter hook is
   * an anonymous callback with none, so the watch ALWAYS runs first. `settle`
   * therefore unfolded with `entering` empty; every later settle bounced off
   * `motion.running(shell)` for as long as that run lasted, and the only
   * thing that ever revealed the column was the drain at the end of it.
   *
   * So the unfold is measured one microtask later — the same device `hold`
   * already uses to make ONE fold out of however many columns leave in a
   * patch, for the same reason: Vue's whole flush, enter hooks included, has
   * run by then, and nothing has painted in between.
   */
  it('waits for the entering columns of this change before unfolding, so ground and content are ONE run', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'pages'
    test.state.secondary = carriedColumn(36, 555)
    test.state.nav = carriedColumn(599, 38)
    test.fold.settle(false)
    test.state.shell = sized(test.shell, 1001)
    // The order App.vue actually produces: the watch settles first, and Vue
    // mounts the entering column afterwards in the same flush.
    test.fold.settle(false)
    expect(test.animations).toHaveLength(0)
    const mine = placed(test.column(348), 645, 348)
    test.fold.enter(mine)
    await settled()
    // ONE ground run, and the column that arrived in the same change is on
    // it rather than waiting for a second one.
    expect(test.animations).toHaveLength(1)
    expect(test.animationsFor(mine)).toHaveLength(1)
    expect(test.railAnimations).toHaveLength(1)
    // All of them on the one transition this fold computed, #464's rule
    // reaching the entering column too.
    expect(test.animationsFor(mine)[0]!.transition).toEqual(test.railAnimations[0]!.transition)
    // And when the run ends there is nothing left to drain: the second phase
    // is gone rather than merely shorter.
    test.animations[0]!.finish()
    await settled()
    expect(test.animations).toHaveLength(1)
    test.wrapper.unmount()
  })

  /*
   * ADDED for #566 T5b, from a real-window probe. Two gaps, both found live
   * and neither visible in a single-grow test:
   *
   * 1. A settle that runs before the viewport has actually reached the width
   *    `enter` pre-placed a column for reads a box that has not moved yet —
   *    main's `setBounds` resolves synchronously inside the IPC handler, but
   *    the RENDERER's own layout catches up on the browser's own schedule.
   *    `width > box` alone answers "should the ground unfold", never "is
   *    there a column still waiting to be revealed" — the entering column can
   *    arrive inside the SAME jump a PRIOR grow's own settle already
   *    consumed (a mine opening a tick after a secondary panel did, in the
   *    probed case), leaving `box` already equal to the current width by the
   *    time anyone asks again. `settle` now also unfolds whenever `entering`
   *    is non-empty, regardless of the width comparison.
   * 2. #488 named the width gap itself and left it for "the next lever if a
   *    symptom needs it"; a pre-placed entering column staying invisible for
   *    good, measured live, is that symptom. `caughtUp` (the `resize`
   *    listener) now answers it even with no fold `pinned` — nothing else was
   *    ever going to ask `settle` again once the ground's own run, if any,
   *    had finished.
   */
  it('unfolds a pending entering column on its own settle, even where the box did not move', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'pages'
    test.state.secondary = carriedColumn(36, 555)
    test.state.nav = carriedColumn(599, 38)
    test.fold.settle(false)
    const mine = placed(test.column(348), 645, 348)
    test.fold.enter(mine)
    // The SAME 645px box as the settle above — main may already have grown
    // the real window, but nothing here says so — and the entering column is
    // still carried: `entering` being non-empty is answer enough on its own.
    test.fold.settle(false)
    // AMENDED for #585: the unfold waits one microtask for the columns of
    // this change to register, so what it starts is observed after it.
    await settled()
    expect(test.animationsFor(mine)[0]!.keyframes).toEqual({
      clipPath: ['inset(0px 0px 0px 356px)', 'inset(0px 0px 0px 0px)']
    })
    test.wrapper.unmount()
  })

  it('lets the window’s own resize carry a pre-placed entering column, with nothing else ever asking settle again', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'pages'
    test.state.secondary = carriedColumn(36, 555)
    test.state.nav = carriedColumn(599, 38)
    test.fold.settle(false)
    const mine = placed(test.column(348), 645, 348)
    test.fold.enter(mine)
    expect(test.animationsFor(mine)).toHaveLength(0)
    // AMENDED for #585: the mine column is pre-placed by its clip alone.
    expect(mine.style.clipPath).toBe('inset(0px 0px 0px 356px)')
    // The window's own resize arrives on its own schedule; nothing here
    // calls `settle` directly — `caughtUp` is the only thing left standing.
    test.state.shell = sized(test.shell, 1001)
    window.dispatchEvent(new Event('resize'))
    // AMENDED for #585: the unfold waits one microtask for the columns of
    // this change to register, so what it starts is observed after it.
    await settled()
    // AMENDED for #585 round 3: measured to the strip's returning edge — see
    // the pre-place case above.
    expect(test.animationsFor(mine)[0]!.keyframes).toEqual({
      clipPath: ['inset(0px 0px 0px 348px)', 'inset(0px 0px 0px -8px)']
    })
    expect(test.railAnimations[0]!.keyframes).toEqual(carries(356, 0))
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585 round 2, from the mechanism trace of the merged fix. A is
   * still two runs, and the microtask cannot help it: the native `resize`
   * lands BEFORE Vue mounts the entering columns (3.4ms against 24.4ms cold,
   * 1.6 against 7.6 warm), so `caughtUp` unfolds with `entering` empty and
   * there is nothing queued anywhere for a microtask to wait behind. B and E
   * only work because there the mount happens to land first (30.6 against
   * 35.7).
   *
   * So the unfold waits on BOTH, whichever arrives last: main having finished
   * answering, and the columns of that answer having registered. While the
   * request is in flight nothing is unfolded AND nothing is consumed — the
   * footprint the unfold must start from is the one from before the grow, and
   * a settle that wrote the new width over it would leave the ground with
   * nothing left to reveal.
   */
  it('waits for main to finish answering before unfolding, even when the resize lands first', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'pages'
    test.state.secondary = carriedColumn(36, 555)
    test.state.nav = carriedColumn(599, 38)
    test.fold.settle(false)
    // The request goes out, and main resizes the native window synchronously
    // inside its own handler: the renderer sees the resize long before Vue
    // has been told anything.
    test.state.applying = true
    test.state.shell = sized(test.shell, 1001)
    window.dispatchEvent(new Event('resize'))
    await settled()
    expect(test.animations).toHaveLength(0)
    // Main answers; Vue mounts the arriving column and settles in the same
    // flush, and the unfold is measured on the microtask after it.
    test.state.applying = false
    const mine = placed(test.column(348), 645, 348)
    test.fold.enter(mine)
    test.fold.settle(false)
    await settled()
    expect(test.animations).toHaveLength(1)
    // From the footprint the shell had BEFORE the grow — proof that the
    // gated settle consumed nothing on its way past.
    expect(clipFrames(test.animations[0]!.keyframes)[0]).toBe(
      'inset(0px 0px 0px calc(100% - 645px) round 12px)'
    )
    expect(test.animationsFor(mine)).toHaveLength(1)
    expect(test.railAnimations).toHaveLength(1)
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585 round 2, from the probe of closing a mine with the
   * secondary panel already shut — [rail][nav][mine] to [rail], the one
   * composition where two columns leave in two different Vue patches (the
   * navigation stack goes one tick after the mine, which AGENTS.md already
   * records). Two batches opened, `begin` ran twice, and the second run
   * claimed the ground from the first: every column snapped to its end state
   * in the first 5ms and never animated at all, the ground folded 61 of the
   * 417px it owed because the second fold only knew about the navigation
   * stack, and the remaining 356 arrived as the native resize jump 300ms
   * later.
   *
   * A column that leaves while a fold is still running belongs to that fold:
   * it joins the batch already in flight, which re-measures the union from
   * the same footprint and runs once. The superseded run writes nothing on
   * its way out — its settle is what snapped every column before.
   */
  it('coalesces columns leaving in separate ticks into ONE fold over the union', async () => {
    const test = harness({ width: 438 })
    test.state.remaining = 'rail'
    // The row is [rail][nav][mine] against the docked edge: 8px of padding,
    // 20 + 38 + 348 of column and a gap between each.
    const nav = placed(test.column(38), 36, 38)
    const mine = placed(test.column(348), 82, 348)
    // The mine column goes on the view's own change...
    const first = test.fold.hold(mine)!
    await settled()
    expect(test.animations).toHaveLength(1)
    // ...and the navigation stack one tick later, on the layout's.
    const second = test.fold.hold(nav)!
    await settled()
    // One fold for the change: the same two moments to wait on, and a ground
    // whose last word is the union rather than the second column alone (which
    // measured 376 of 438 live — the ground barely moved).
    expect(second).toBe(first)
    const folds = test.animations
    expect(clipFrames(folds[folds.length - 1]!.keyframes)[1]).toBe(
      'inset(0px 0px 0px calc(100% - 20px) round 12px)'
    )
    // From the footprint the first fold started at, not from what it had
    // already written: nothing was settled on the way past.
    expect(clipFrames(folds[folds.length - 1]!.keyframes)[0]).toBe(
      'inset(0px 0px 0px 0px round 12px)'
    )
    expect(test.shell.style.clipPath).toBe('')
    // And every column of the change is carried by the fold that survives.
    expect(test.animationsFor(nav)).toHaveLength(1)
    expect(test.animationsFor(mine).length).toBeGreaterThanOrEqual(1)
    expect(test.railAnimations.length).toBeGreaterThanOrEqual(1)
    folds[folds.length - 1]!.finish()
    await settled()
    expect(test.shell.style.clipPath).toBe('inset(0px 0px 0px calc(100% - 20px) round 12px)')
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585 round 2. The columns of that one fold keep the roles the
   * row gives them: the navigation stack is a drawer sliding into the wall
   * docked of it, and the mine column — docked-most, with the whole row on
   * its free side — is clipped from its free side without moving at all.
   * Both on the transition the ground is folding under.
   */
  it('gives every column of a coalesced fold its own role, on the fold’s one transition', async () => {
    const test = harness({ width: 438 })
    test.state.remaining = 'rail'
    const nav = placed(test.column(38), 36, 38)
    const mine = placed(test.column(348), 82, 348)
    void test.fold.hold(mine)
    await settled()
    void test.fold.hold(nav)
    await settled()
    const mineRuns = test.animationsFor(mine)
    // AMENDED for #585 round 3: what covers the mine here is the strip sliding
    // over it, a gap away at rest and 402 nearer by the end of its own travel
    // — so the clip runs to 394, past the mine's own 348, and is already whole
    // where the strip stops sweeping and starts disappearing into its wall.
    expect(mineRuns[mineRuns.length - 1]!.keyframes).toEqual({
      clipPath: ['inset(0px 0px 0px -8px)', 'inset(0px 0px 0px 394px)']
    })
    // AMENDED for #585 round 2: the strip does not only disappear into its own
    // mouth, it FOLLOWS the 356px the mine column vacates under it first — see
    // the case below, which is what measured the difference. AMENDED again
    // for round 3: its mouth is the shell's own docked edge, and that wall
    // clips it exactly (`overflow: hidden`), where a clip of its own drawn as
    // two keyframes thinned it over the whole slide.
    expect(test.animationsFor(nav)[0]!.keyframes).toEqual(carries(0, 402))
    const folds = test.animations
    expect(test.animationsFor(nav)[0]!.transition).toEqual(
      test.railAnimations[test.railAnimations.length - 1]!.transition
    )
    expect(folds[folds.length - 1]!.transition).toBeUndefined()
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585 round 2, from the probe of the coalesced fold. Closing a
   * mine with the secondary panel shut left 55px of bare ground where the
   * composition draws 32 at rest, and the frames say where: the ground's free
   * edge sweeps the whole 417px and the rail rides it, while the navigation
   * strip travelled only the 46 of its own width and gap — so the sweep
   * overtook the strip within two frames and left a 41px band between the
   * rail and the mine with nothing in it.
   *
   * A leaving column is a surviving column that also disappears: it follows
   * the room the columns docked of it are vacating, exactly as the rail does,
   * and retreats into its own mouth on top of that. Its clip is measured to
   * that mouth, which is now moving too, so what it ends up clipping is still
   * exactly its own width.
   */
  it('carries a leaving drawer over the room the columns docked of it vacate', async () => {
    const test = harness({ width: 438 })
    test.state.remaining = 'rail'
    const nav = placed(test.column(38), 36, 38)
    const mine = placed(test.column(348), 82, 348)
    void test.fold.hold(mine)
    await settled()
    void test.fold.hold(nav)
    await settled()
    // 356 vacated by the mine column, then 38 + 8 of its own. AMENDED for
    // #585 round 3: no clip of its own, the shell's docked edge is its wall —
    // see the case above.
    expect(test.animationsFor(nav)[0]!.keyframes).toEqual(carries(0, 402))
    // Which is the rail's own travel but for the padding the bare rail drops:
    // the two cross the ground together instead of one outrunning the other.
    expect(transformFrames(test.railAnimations[test.railAnimations.length - 1]!.keyframes)[1]).toBe(
      'translateX(410px)'
    )
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585 round 2. The mine column is the docked-most of the row, so
   * nothing leaving stands docked of it and it has nothing to follow: the
   * clip alone, exactly as before, and no travel of its own.
   */
  it('gives the docked-most leaving column no travel to follow', async () => {
    const test = harness({ width: 438 })
    test.state.remaining = 'rail'
    const nav = placed(test.column(38), 36, 38)
    const mine = placed(test.column(348), 82, 348)
    void test.fold.hold(mine)
    await settled()
    void test.fold.hold(nav)
    await settled()
    const runs = test.animationsFor(mine)
    // AMENDED for #585 round 3: measured to the strip sliding over it — see
    // the coalesced-fold case above.
    expect(runs[runs.length - 1]!.keyframes).toEqual({
      clipPath: ['inset(0px 0px 0px -8px)', 'inset(0px 0px 0px 394px)']
    })
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585 round 3, the maintainer's own words on the merged fix: the
   * rail and the navigation strip are two columns glued together, and pressing
   * the arrow moves the RAIL — the strip stays whole where it is, in its own
   * amber. What the fix before this one did was clip the strip over its own
   * width for the WHOLE run, so a 38px strip took 300ms to appear and read as
   * the strip itself animating.
   *
   * An uncovered column is hidden exactly where the column covering it stands,
   * frame by frame. Here that is the rail, which stood 3px past the strip's
   * free edge before the change (a 25px window holds the rail alone) and comes
   * to rest 571px away from it: the clip runs from 49 — the strip entirely
   * under it, and then some — to −571, whole, on the ONE transition the rail's
   * own carry runs on, so the two edges are the same edge. It crosses zero in
   * the first frame; the strip is whole for the other 290ms.
   */
  it('uncovers the entering strip at the rail’s own edge, whole once the rail has crossed it', async () => {
    const test = harness({ width: 25 })
    test.state.remaining = 'rail'
    test.fold.settle(false)
    test.state.remaining = 'pages'
    const secondary = carriedColumn(36, 555)
    const nav = carriedColumn(599, 38)
    test.state.secondary = secondary
    test.state.nav = nav
    test.fold.enter(secondary)
    test.fold.enter(nav)
    test.state.shell = sized(test.shell, 645)
    test.fold.settle(false)
    await settled()
    expect(test.animationsFor(nav)[0]!.keyframes).toEqual({
      clipPath: ['inset(0px 0px 0px 49px)', 'inset(0px 0px 0px -571px)']
    })
    expect(test.animationsFor(nav)[0]!.transition).toEqual(test.railAnimations[0]!.transition)
    // The drawer beside it is untouched: pulled out from behind the strip's
    // fixed edge, which is what the strip standing still is FOR.
    expect(test.animationsFor(secondary)[0]!.keyframes).toEqual({
      ...carries(563, 0),
      clipPath: ['inset(0px 555px 0px 0px)', 'inset(0px 0px 0px 0px)']
    })
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585 round 3, the same rule closing. The strip is the WALL the
   * drawer goes back behind, and a wall does not move out of the way of its
   * own drawer: leaving together with the strip, the secondary panel's mouth
   * stays at the strip's edge (a travel of its own width and gap, clipped by
   * its width — never the strip's 46 on top), and the strip stands whole until
   * the rail arrives over it at the very end — 571px away at the start, 46
   * over it when the fold lands. Without the strip named, round 2 let the
   * drawer follow the strip's own room and slide over it in the first frames.
   */
  it('keeps the strip whole until the rail comes back over it, and its drawer’s mouth at its edge', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'rail'
    const secondary = carriedColumn(36, 555)
    const nav = carriedColumn(599, 38)
    test.state.secondary = secondary
    test.state.nav = nav
    void test.fold.hold(secondary)
    void test.fold.hold(nav)
    await settled()
    expect(test.animationsFor(secondary)[0]!.keyframes).toEqual({
      ...carries(0, 563),
      clipPath: ['inset(0px 0px 0px 0px)', 'inset(0px 555px 0px 0px)']
    })
    expect(test.animationsFor(nav)[0]!.keyframes).toEqual({
      clipPath: ['inset(0px 0px 0px -571px)', 'inset(0px 0px 0px 46px)']
    })
    expect(nav.style.transform).toBe('')
    expect(transformFrames(test.railAnimations[0]!.keyframes)[1]).toBe('translateX(617px)')
    test.wrapper.unmount()
  })

  /*
   * ADDED for #585 round 3, from the first real-window probe of this fix. Vue
   * nulls a leaving component's template ref while its element is still in
   * the DOM, so at the moment `begin` measures the pages closing, `strip`
   * reads `null` — and the drawer followed the strip's room again, hiding it
   * in the first frames. The strip is remembered from the last time it was
   * seen standing, which every settle while it stood was.
   */
  it('still knows which leaving column is the strip once Vue has nulled its ref', async () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'pages'
    const secondary = carriedColumn(36, 555)
    const nav = carriedColumn(599, 38)
    test.state.secondary = secondary
    test.state.nav = nav
    test.fold.settle(false)
    // The way Vue actually hands a leaving strip over: the ref is gone, the
    // element is not.
    test.state.remaining = 'rail'
    test.state.secondary = null
    test.state.nav = null
    void test.fold.hold(secondary)
    void test.fold.hold(nav)
    await settled()
    expect(test.animationsFor(secondary)[0]!.keyframes).toEqual({
      ...carries(0, 563),
      clipPath: ['inset(0px 0px 0px 0px)', 'inset(0px 555px 0px 0px)']
    })
    expect(test.animationsFor(nav)[0]!.keyframes).toEqual({
      clipPath: ['inset(0px 0px 0px -571px)', 'inset(0px 0px 0px 46px)']
    })
    test.wrapper.unmount()
  })

  it('reveals a pre-placed column at once on teardown, rather than leave it invisible for good', () => {
    const test = harness({ width: 645 })
    const mine = placed(test.column(348), 645, 348)
    test.fold.enter(mine)
    // AMENDED for #585: the mine column is pre-placed by its clip alone now,
    // so the clip is what proves it was hidden — and both properties are
    // still what teardown has to hand back.
    expect(mine.style.clipPath).not.toBe('')
    test.wrapper.unmount()
    expect(mine.style.transform).toBe('')
    expect(mine.style.clipPath).toBe('')
  })

  it('pre-places nothing for an entering column a hidden window could not carry, and waits on nothing', () => {
    const test = harness({ width: 645, hidden: true })
    const mine = placed(test.column(348), 645, 348)
    test.fold.enter(mine)
    expect(mine.style.transform).toBe('')
    expect(mine.style.clipPath).toBe('')
    test.wrapper.unmount()
  })
})
