// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useShellFold } from './useShellFold'
import { PANEL_LEAVE_BOUND_MS, PANEL_MOTION_WATCHDOG_MS } from '../lib/shell/panelMotion'
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
  const record =
    (into: typeof animations) => (keyframes: Keyframe[], timing: KeyframeAnimationOptions) => {
      let finish!: () => void
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const cancel = vi.fn()
      into.push({ keyframes, timing, finish, cancel })
      return { finished, cancel }
    }
  Object.defineProperty(shell, 'animate', { configurable: true, value: record(animations) })
  document.body.append(shell)

  /*
   * AMENDED for #464, optional and defaulted so every case above is untouched.
   * The rail travels with the fold now — it stands at the shell's FREE edge
   * while a page is open, which is the end of the shell the fold clips away —
   * so the composable has to be handed it, and its own animation is recorded
   * apart from the ground's rather than counted among them.
   */
  const railAnimations: typeof animations = []
  const rail = placed(document.createElement('div'), 8, 20)
  Object.defineProperty(rail, 'animate', { configurable: true, value: record(railAnimations) })
  shell.append(rail)

  const state = {
    edge: 'right' as PanelEdge,
    remaining: 'pages' as ShellComposition,
    shell,
    rail: rail as HTMLElement | null
  }
  let fold!: ReturnType<typeof useShellFold>
  const wrapper = mount(
    defineComponent({
      setup: () => {
        fold = useShellFold({
          shell: () => state.shell,
          edge: () => state.edge,
          remaining: () => state.remaining,
          rail: () => state.rail
        })
        return () => h('div')
      }
    })
  )
  const column = (width: number): HTMLElement => sized(document.createElement('div'), width)
  return {
    animations,
    railAnimations,
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
    await vi.advanceTimersByTimeAsync(PANEL_MOTION_WATCHDOG_MS)
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
    expect(test.railAnimations[0]!.keyframes).toEqual([
      { transform: 'translateX(0px)' },
      { transform: 'translateX(563px)' }
    ])
    expect(test.railAnimations[0]!.timing).toEqual({
      duration: 250,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      fill: 'both'
    })
    test.animations[0]!.finish()
    await settled()
    // Written rather than left to the animation: cancelling drops `fill: both`,
    // and the rail would snap back to the free edge for the frame between the
    // fold ending and main resizing the window around it.
    expect(test.rail.style.transform).toBe('translateX(563px)')
    sized(test.shell, 438)
    test.fold.settle(false)
    // The row has caught up with the fold, so the travel is the layout's own
    // again and holding the transform would push the rail out of the window.
    expect(test.rail.style.transform).toBe('')
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
    expect(test.railAnimations[0]!.keyframes[1]).toEqual({ transform: 'translateX(-563px)' })
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
    await vi.advanceTimersByTimeAsync(PANEL_LEAVE_BOUND_MS)
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
    expect(test.animations[0]!.keyframes[1]).toEqual({
      clipPath: 'inset(0px 0px 0px calc(100% - 438px) round 12px)'
    })
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
    expect(test.railAnimations[1]!.keyframes).toEqual([
      { transform: 'translateX(617px)' },
      { transform: 'translateX(0px)' }
    ])
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
