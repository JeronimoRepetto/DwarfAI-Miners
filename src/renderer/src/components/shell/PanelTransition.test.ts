// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DOMKeyframesDefinition } from 'motion-v'
import PanelTransition from './PanelTransition.vue'
import { panelKeyframes } from '../../lib/shell/panelMotion'
import { motionBoundMs } from '../../lib/shell/motionTiming'
import type { MotionAnimate } from '../../lib/shell/boundedMotion'
import type { ShellFoldHold } from '../../composables/useShellFold'

// AMENDED for #266 (was: `afterEach(() => vi.unstubAllGlobals())`) — the
// watchdog owns a timer and the hidden-window release reads `document.hidden`,
// and neither may outlive the test that set it.
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Reflect.deleteProperty(document, 'hidden')
})

/** Report the window as Chromium sees it once another program occludes it. */
function occlude(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
}

/*
 * AMENDED for #388 (was: `harness(reduced = false, axis?)`). The shell's
 * columns no longer animate themselves — the ground folds under them — so the
 * harness has to be able to hand this component the fold it waits on. Optional
 * and last, so every case above it is untouched.
 */
/*
 * AMENDED again for #396 with `watchable`, optional and last for the same
 * reason: a platform that can report the preference but not its changing is a
 * query with no `addEventListener` on it, and every case above is untouched.
 */
/*
 * AMENDED again for #464: the fold answers TWO moments where it answered one.
 * `folded` is what the shrink waits on and `released` is what may unmount the
 * column — main resizing the window is a whole IPC round trip after the fold
 * ends, and the row may not repack inside the old rectangle in between.
 */
/*
 * AMENDED for #566 T5b with `holdEnter`, optional and last for the same
 * reason `watchable` is: the mirror of `hold` for a column ENTERING, so a
 * test can prove it is asked and prove `done` never waits on it — every case
 * above this one is untouched.
 */
function harness(
  reduced = false,
  axis?: 'horizontal' | 'vertical',
  hold?: (column: HTMLElement) => ShellFoldHold | null,
  watchable = true,
  holdEnter?: (column: HTMLElement) => void
) {
  const media = new EventTarget() as MediaQueryList
  Object.defineProperty(media, 'matches', { configurable: true, value: reduced })
  vi.stubGlobal('matchMedia', () => (watchable ? media : { matches: reduced }))
  const animations: { finish: () => void; cancel: ReturnType<typeof vi.fn> }[] = []
  // A hand-written stand-in for motion-v's own `animate()` — AMENDED for #566
  // (was: stubbing `element.animate`, WAAPI's own entry point, which the
  // runner no longer calls). `animate` stays a spy so the call-shape
  // assertions below keep working; only what it is called WITH changed.
  //
  // AMENDED again for #566: no third `options` argument any more — the
  // runner passes `animate()` no transition at all now, so a fake that took
  // one would be shaped for a call the real runner never makes.
  const animate = vi.fn((element: Element, _keyframes: DOMKeyframesDefinition) => {
    let resolve!: () => void
    const finished = new Promise<void>((res) => {
      resolve = res
    })
    const cancel = vi.fn()
    // Writes a stray inline value the way the real engine would, so a test
    // can prove the panel gets it handed back rather than keeping it —
    // `PanelTransition` passes no `settle` of its own, unlike `useShellFold`
    // and `MessagePanelWindow`.
    const finish = (): void => {
      ;(element as HTMLElement).style.opacity = '1'
      resolve()
    }
    animations.push({ finish, cancel })
    return {
      cancel,
      then: (onResolve: () => void, onReject?: () => void) => finished.then(onResolve, onReject)
    }
  }) as unknown as (
    element: Element,
    keyframes: DOMKeyframesDefinition
  ) => ReturnType<MotionAnimate>
  const shown = ref(false)
  const leaves: Promise<void>[] = []
  const wrapper = mount(
    defineComponent({
      setup: () => () =>
        h('section', [
          h(
            PanelTransition,
            {
              axis,
              hold,
              holdEnter,
              engine: animate as unknown as MotionAnimate,
              onLeave: (leave: Promise<void>) => leaves.push(leave)
            },
            {
              default: () =>
                shown.value
                  ? h(
                      'div',
                      {
                        key: 'panel',
                        // `still()` reads this only as the app's proxy for "a
                        // real Chromium window" (motion-v needs no such
                        // method to run) — jsdom has none, so the panel needs
                        // one for the motion path to be taken at all.
                        ref: (el) => {
                          if (el)
                            Object.defineProperty(el, 'animate', {
                              configurable: true,
                              value: () => undefined
                            })
                        }
                      },
                      'Panel'
                    )
                  : null
            }
          )
        ])
    }),
    { global: { stubs: { transition: false } } }
  )
  return { wrapper, shown, media, animations, animate, leaves }
}

describe('PanelTransition', () => {
  it('animates entry and retains an inert leaving panel until its motion actually finishes', async () => {
    const test = harness()
    test.shown.value = true
    await nextTick()
    // No transition is asked for any more (#566) — the runner hands motion-v
    // only the keyframes, and lets `getDefaultTransition` pick.
    expect(test.animate).toHaveBeenLastCalledWith(expect.any(HTMLElement), {
      opacity: [0, 1],
      x: [12, 0]
    })
    test.animations[0]!.finish()
    await nextTick()
    test.shown.value = false
    await nextTick()
    expect(test.wrapper.find('div').exists()).toBe(true)
    expect((test.wrapper.find('div').element as HTMLElement).inert).toBe(true)
    expect(test.leaves).toHaveLength(1)
    test.animations[1]!.finish()
    await test.leaves[0]
    await nextTick()
    expect(test.wrapper.find('div').exists()).toBe(false)
    test.wrapper.unmount()
  })

  /*
   * ADDED for #566. WAAPI's `fill: 'both'` composited on top of `element.style`
   * and cost nothing to drop with `cancel()`; motion-v writes its final frame
   * straight into `element.style` instead. This component passes no `settle`
   * of its own, so the bound has to hand the property back on its behalf —
   * otherwise a panel that finished entering would carry a stray inline
   * `opacity: 1` forever, on an element the stylesheet already draws at full
   * strength.
   */
  it('carries no stray inline style once an entering panel has settled', async () => {
    const test = harness()
    test.shown.value = true
    await nextTick()
    test.animations[0]!.finish()
    await nextTick()
    expect((test.wrapper.find('div').element as HTMLElement).style.opacity).toBe('')
    test.wrapper.unmount()
  })

  it('uses no animation or delayed removal when reduced motion is already requested', async () => {
    const test = harness(true)
    test.shown.value = true
    await nextTick()
    test.shown.value = false
    await nextTick()
    expect(test.animate).not.toHaveBeenCalled()
    expect(test.wrapper.find('div').exists()).toBe(false)
    test.wrapper.unmount()
  })

  it('finishes an active leave immediately when reduced motion changes live', async () => {
    const test = harness()
    test.shown.value = true
    await nextTick()
    test.animations[0]!.finish()
    await nextTick()
    test.shown.value = false
    await nextTick()
    Object.defineProperty(test.media, 'matches', { value: true })
    test.media.dispatchEvent(new Event('change'))
    await test.leaves[0]
    await nextTick()
    expect(test.animations[1]!.cancel).toHaveBeenCalledOnce()
    expect(test.wrapper.find('div').exists()).toBe(false)
    test.wrapper.unmount()
  })

  it('cancels an interrupted enter and never lets an old leave remove a reopened panel', async () => {
    const test = harness()
    test.shown.value = true
    await nextTick()
    test.shown.value = false
    await nextTick()
    expect(test.animations[0]!.cancel).toHaveBeenCalledOnce()
    test.shown.value = true
    await nextTick()
    await test.leaves[0]
    expect(test.animations[1]!.cancel).toHaveBeenCalledOnce()
    test.animations[1]!.finish()
    await nextTick()
    expect(test.wrapper.findAll('div')).toHaveLength(1)
    expect((test.wrapper.find('div').element as HTMLElement).inert).toBe(false)
    test.wrapper.unmount()
    expect(test.animations[2]!.cancel).toHaveBeenCalledOnce()
  })

  it('releases a leave whose animation never reports finishing, once the watchdog elapses (#266)', async () => {
    // Chromium freezes the document timeline for an occluded window: the last
    // frame lands on the compositor and `finished` never settles. Waiting on
    // it alone wedged the layout queue and stranded the shell as a yellow box.
    vi.useFakeTimers()
    const test = harness()
    test.shown.value = true
    await nextTick()
    test.animations[0]!.finish()
    await nextTick()
    test.shown.value = false
    await nextTick()
    expect(test.leaves).toHaveLength(1)
    let released = false
    void test.leaves[0]!.then(() => {
      released = true
    })
    // The default harness is a horizontal dock: the same leave keyframes
    // `PanelTransition.run` actually animates (`panelKeyframes(true, false,
    // 12)` — `panelMotionX` reads jsdom's absent `--panel-motion-x` as its
    // own 12px fallback), so the watchdog this waits out is the one the run
    // itself would be armed with.
    await vi.advanceTimersByTimeAsync(motionBoundMs(panelKeyframes(true, false, 12)))
    await nextTick()
    expect(released).toBe(true)
    expect(test.animations[1]!.cancel).toHaveBeenCalledOnce()
    expect(test.wrapper.find('div').exists()).toBe(false)
    test.wrapper.unmount()
  })

  it('finishes an active leave the moment the window becomes hidden (#266)', async () => {
    const test = harness()
    test.shown.value = true
    await nextTick()
    test.animations[0]!.finish()
    await nextTick()
    test.shown.value = false
    await nextTick()
    occlude(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await test.leaves[0]
    await nextTick()
    expect(test.animations[1]!.cancel).toHaveBeenCalledOnce()
    expect(test.wrapper.find('div').exists()).toBe(false)
    test.wrapper.unmount()
  })

  it('never starts an animation the hidden window cannot advance, and waits on nothing (#266)', async () => {
    occlude(true)
    const test = harness()
    test.shown.value = true
    await nextTick()
    test.shown.value = false
    await nextTick()
    expect(test.animate).not.toHaveBeenCalled()
    expect(test.leaves).toHaveLength(0)
    expect(test.wrapper.find('div').exists()).toBe(false)
    test.wrapper.unmount()
  })

  /*
   * ADDED for #388. The shell's three columns hand their motion to the ground
   * they stand on: one fold of the whole shell, rather than a fade each inside
   * a window that then jumps. This component still holds the leaving column —
   * unmounting it early would repack the row inside a window that has not
   * shrunk yet — but it animates nothing of its own.
   */
  it('lets the shell’s own fold be the motion of a column that has none', async () => {
    let fold!: () => void
    const held = new Promise<void>((resolve) => {
      fold = resolve
    })
    // AMENDED for #464: the same one promise, now answered for both moments —
    // what this case is about is the fold being reported as the leave, and the
    // case below it is the one that tells the two moments apart.
    const test = harness(false, undefined, () => ({ folded: held, released: held }))
    test.shown.value = true
    await nextTick()
    expect(test.animate).not.toHaveBeenCalled()
    test.shown.value = false
    await nextTick()
    expect(test.wrapper.find('div').exists()).toBe(true)
    expect((test.wrapper.find('div').element as HTMLElement).inert).toBe(true)
    expect(test.animate).not.toHaveBeenCalled()
    // The fold is what the shrink waits on, so it has to be reported as the
    // leave exactly as an animation of this column's own would have been.
    expect(test.leaves).toEqual([held])
    fold()
    await held
    await nextTick()
    expect(test.wrapper.find('div').exists()).toBe(false)
    test.wrapper.unmount()
  })

  it('removes a held column at once when the shell reports no fold to wait for', async () => {
    const test = harness(false, undefined, () => null)
    test.shown.value = true
    await nextTick()
    test.shown.value = false
    await nextTick()
    expect(test.animate).not.toHaveBeenCalled()
    expect(test.leaves).toHaveLength(0)
    expect(test.wrapper.find('div').exists()).toBe(false)
    test.wrapper.unmount()
  })

  /*
   * ADDED for #464. The fold ending is not the window having been resized: the
   * shrink it releases is a whole IPC round trip long, and a column unmounted
   * inside it repacks the row under a clip made for the row that was there.
   * `.shell-secondary` is `flex: 1`, so what those frames showed was the fold's
   * strip painted over bare ground.
   */
  it('keeps a held column standing after the fold, until the shell releases it', async () => {
    let fold!: () => void
    let catchUp!: () => void
    const folded = new Promise<void>((resolve) => {
      fold = resolve
    })
    const released = new Promise<void>((resolve) => {
      catchUp = resolve
    })
    const test = harness(false, undefined, () => ({ folded, released }))
    test.shown.value = true
    await nextTick()
    test.shown.value = false
    await nextTick()
    // The fold is what the shrink waits on, and only the fold: the window
    // cannot be asked to resize by something that is waiting for it to have.
    expect(test.leaves).toEqual([folded])
    fold()
    await folded
    await nextTick()
    expect(test.wrapper.find('div').exists()).toBe(true)
    catchUp()
    await released
    await nextTick()
    expect(test.wrapper.find('div').exists()).toBe(false)
    test.wrapper.unmount()
  })

  it('releases a held column on teardown, so an unfinished fold cannot strand it', async () => {
    const stranded = new Promise<void>(() => undefined)
    const test = harness(false, undefined, () => ({ folded: stranded, released: stranded }))
    test.shown.value = true
    await nextTick()
    test.shown.value = false
    await nextTick()
    expect(test.wrapper.find('div').exists()).toBe(true)
    test.wrapper.unmount()
    expect(test.wrapper.find('div').exists()).toBe(false)
  })

  /*
   * ADDED for #396. The listener this component keeps of its own is the one
   * that ends a column held by the shell's FOLD, which has no animation of the
   * runner's behind it — but it went through a `matchMedia` written out here
   * for the third time. `sceneMotion` owns the app's one query (#71), and a
   * platform that answers it without being able to watch it keeps the answer
   * instead of taking the panel down on the listener.
   */
  it('mounts where the reduced-motion query cannot be watched, keeping the answer it gave', async () => {
    const test = harness(false, undefined, undefined, false)
    test.shown.value = true
    await nextTick()
    expect(test.animate).toHaveBeenCalledOnce()
    test.animations[0]!.finish()
    await nextTick()
    test.wrapper.unmount()
  })

  it('uses the same keyframe shape for a vertical dock and releases its leave on teardown', async () => {
    const test = harness(false, 'vertical')
    test.shown.value = true
    await nextTick()
    expect(test.animate).toHaveBeenCalledWith(expect.any(HTMLElement), {
      opacity: [0, 1],
      y: [12, 0]
    })
    test.shown.value = false
    await nextTick()
    test.wrapper.unmount()
    await test.leaves[0]
    expect(test.animations[1]!.cancel).toHaveBeenCalledOnce()
  })

  /*
   * ADDED for #566 T5b. The mirror of "lets the shell’s own fold be the
   * motion of a column that has none": an entering held column has no motion
   * of ITS OWN either, but unlike a leaving one it is not held past `done` —
   * there is nothing to unmount and nothing a shrink needs to wait on, so
   * `holdEnter` is asked and `done` fires at once regardless of what it does.
   */
  it('hands an entering held column to the shell’s own fold, without waiting on it', async () => {
    const entered: HTMLElement[] = []
    const test = harness(
      false,
      undefined,
      () => null,
      true,
      (column) => {
        entered.push(column)
      }
    )
    test.shown.value = true
    await nextTick()
    expect(entered).toHaveLength(1)
    expect(entered[0]).toBe(test.wrapper.find('div').element)
    expect(test.animate).not.toHaveBeenCalled()
    expect(test.wrapper.find('div').exists()).toBe(true)
    test.wrapper.unmount()
  })

  it('mounts a held column at once when no holdEnter is given for it', async () => {
    const test = harness(false, undefined, () => null)
    test.shown.value = true
    await nextTick()
    expect(test.wrapper.find('div').exists()).toBe(true)
    expect(test.animate).not.toHaveBeenCalled()
    test.wrapper.unmount()
  })
})
