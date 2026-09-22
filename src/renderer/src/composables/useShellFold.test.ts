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
    nav: null as HTMLElement | null
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
    // The rail rested against the docked edge; the row has just put it back at
    // the free one, 617px away from where the unfold has to start.
    expect(test.railAnimations[1]!.keyframes).toEqual(carries(617, 0))
    expect(test.rail.style.transform).toBe('translateX(617px)')
    test.animations[1]!.finish()
    await settled()
    expect(test.rail.style.transform).toBe('')
    test.wrapper.unmount()
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
   */
  it('slides and clips the leaving column itself, on the same transition as the carries beside it', async () => {
    const test = harness({ width: 1001 })
    test.state.remaining = 'pages'
    test.state.secondary = carriedColumn(36, 555)
    test.state.nav = carriedColumn(599, 38)
    const mine = placed(test.column(348), 645, 348)
    void test.fold.hold(mine)
    await settled()
    const own = test.animationsFor(mine)
    expect(own).toHaveLength(1)
    expect(own[0]!.keyframes).toEqual({
      ...carries(0, 356),
      clipPath: ['inset(0px 0px 0px 0px)', 'inset(0px 356px 0px 0px)']
    })
    // The clip's own transition — never `x`'s underdamped spring default —
    // the same rule `carry` already proved for the rail.
    expect(own[0]!.transition).toEqual(test.railAnimations[0]!.transition)
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
    expect(test.animationsFor(mine)[0]!.keyframes).toEqual({
      ...carries(-0, -356),
      clipPath: ['inset(0px 0px 0px 0px)', 'inset(0px 0px 0px 356px)']
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
    // browser — nothing here has awaited a microtask yet.
    expect(mine.style.transform).toBe('translateX(356px)')
    expect(mine.style.clipPath).toBe('inset(0px 356px 0px 0px)')
    expect(test.animationsFor(mine)).toHaveLength(0)
    test.state.shell = sized(test.shell, 1001)
    test.fold.settle(false)
    expect(test.animationsFor(mine)[0]!.keyframes).toEqual({
      ...carries(356, 0),
      clipPath: ['inset(0px 356px 0px 0px)', 'inset(0px 0px 0px 0px)']
    })
    expect(test.railAnimations[0]!.keyframes).toEqual(carries(356, 0))
    expect(test.secondaryAnimations[0]!.keyframes).toEqual(carries(356, 0))
    expect(test.navAnimations[0]!.keyframes).toEqual(carries(356, 0))
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
  it('unfolds a pending entering column on its own settle, even where the box did not move', () => {
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
    expect(test.animationsFor(mine)[0]!.keyframes).toEqual({
      ...carries(356, 0),
      clipPath: ['inset(0px 356px 0px 0px)', 'inset(0px 0px 0px 0px)']
    })
    test.wrapper.unmount()
  })

  it('lets the window’s own resize carry a pre-placed entering column, with nothing else ever asking settle again', () => {
    const test = harness({ width: 645 })
    test.state.remaining = 'pages'
    test.state.secondary = carriedColumn(36, 555)
    test.state.nav = carriedColumn(599, 38)
    test.fold.settle(false)
    const mine = placed(test.column(348), 645, 348)
    test.fold.enter(mine)
    expect(test.animationsFor(mine)).toHaveLength(0)
    expect(mine.style.transform).toBe('translateX(356px)')
    // The window's own resize arrives on its own schedule; nothing here
    // calls `settle` directly — `caughtUp` is the only thing left standing.
    test.state.shell = sized(test.shell, 1001)
    window.dispatchEvent(new Event('resize'))
    expect(test.animationsFor(mine)[0]!.keyframes).toEqual({
      ...carries(356, 0),
      clipPath: ['inset(0px 356px 0px 0px)', 'inset(0px 0px 0px 0px)']
    })
    expect(test.railAnimations[0]!.keyframes).toEqual(carries(356, 0))
    test.wrapper.unmount()
  })

  it('reveals a pre-placed column at once on teardown, rather than leave it invisible for good', () => {
    const test = harness({ width: 645 })
    const mine = placed(test.column(348), 645, 348)
    test.fold.enter(mine)
    expect(mine.style.transform).not.toBe('')
    test.wrapper.unmount()
    expect(mine.style.transform).toBe('')
    expect(mine.style.clipPath).toBe('')
  })

  it('pre-places nothing for an entering column a hidden window could not carry, and waits on nothing', () => {
    const test = harness({ width: 645, hidden: true })
    const mine = placed(test.column(348), 645, 348)
    test.fold.enter(mine)
    expect(mine.style.transform).toBe('')
    test.wrapper.unmount()
  })
})
