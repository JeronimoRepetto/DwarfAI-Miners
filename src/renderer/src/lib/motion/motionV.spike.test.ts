// @vitest-environment jsdom
/**
 * T0 spike probe for issue #566 (go/no-go on `motion-v`). NOT production code —
 * kept only to give the go/no-go decision a pinned, re-runnable proof rather
 * than a one-off script's output pasted into a report. If the decision is GO,
 * T1 replaces this file with the real `lib/motion/` adapter and its own tests;
 * if NO-GO, this file (and the `motion-v` dependency) is removed with it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { AnimatePresence, animate, MotionGlobalConfig, motion } from 'motion-v'

// FINDING: `MotionGlobalConfig` is plain, module-scoped, MUTABLE state with no
// reset API of its own — setting `instantAnimations` in one test silently
// bled into the next one here (an exit given a real 40ms `transition` still
// ran instant, traced back to this). T1's own tests will need the same
// `afterEach` this repo already uses for other global mutable state
// (`vi.unstubAllGlobals()` in `boundedMotion.test.ts`, `PanelTransition.test.ts`).
afterEach(() => {
  MotionGlobalConfig.instantAnimations = false
  MotionGlobalConfig.skipAnimations = false
})

function buildHarness(shown: Ref<boolean>, onExitComplete?: () => void) {
  return defineComponent({
    setup: () => () =>
      h(
        AnimatePresence,
        { onExitComplete },
        {
          default: () =>
            shown.value
              ? h(
                  motion.div,
                  {
                    key: 'panel',
                    initial: { opacity: 0 },
                    animate: { opacity: 1 },
                    exit: { opacity: 0 },
                    transition: { duration: 0.04 }
                  },
                  // FINDING: a bare string here (`h(motion.div, {...}, 'panel')`)
                  // is silently wrong. Vue's `h()` only wraps a function or a
                  // slots object into `{ default: ... }` for a component vnode;
                  // a raw string is normalized as ShapeFlags.TEXT_CHILDREN
                  // instead (that shape flag is meant for elements), so the
                  // component's own `slots.default` ends up not being callable
                  // — the "Non-function value encountered for default slot" Vue
                  // warning this raised, traced to source. It renders, but the
                  // exit hold that this test proves depends on breaks silently
                  // with it. The fix is the same one template compilation would
                  // have produced: a function child.
                  () => 'panel'
                )
              : null
        }
      )
  })
}

describe('motion-v spike: jsdom component mount (AnimatePresence + motion.div)', () => {
  it('mounts under v-if without throwing', async () => {
    // No `Element.animate`, `matchMedia` or `ResizeObserver` stub anywhere in
    // this file — jsdom provides none of the three (confirmed separately: all
    // three are `undefined` on a fresh jsdom `window`), and mounting never
    // touched them.
    MotionGlobalConfig.instantAnimations = true
    const shown = ref(true)
    const Harness = buildHarness(shown)

    let wrapper!: ReturnType<typeof mount>
    expect(() => {
      // FINDING: `@vue/test-utils` stubs `transition`/`transition-group` by
      // default — the stub renders the DOM change but never calls the real
      // `onLeave`/`onEnter` hooks, so `AnimatePresence` (built on
      // `TransitionGroup`) never sees an exit to hold. Confirmed by testing a
      // bare `<TransitionGroup>` with no motion-v involved at all: same
      // silent no-op. `PanelTransition.test.ts` already disables this stub
      // for the same reason (`global: { stubs: { transition: false } } }`);
      // `AnimatePresence` renders a `TransitionGroup`, so both stub keys are
      // disabled here.
      wrapper = mount(Harness, {
        global: { stubs: { transition: false, 'transition-group': false } }
      })
    }).not.toThrow()
    await nextTick()
    expect(wrapper.find('div').exists()).toBe(true)
    wrapper.unmount()
  })

  it('removes the leaving element only once AnimatePresence reports its own exit as complete, never synchronously with the v-if flip', async () => {
    // FINDING (source-traced through use-presence-container.mjs and
    // exit-session.mjs, confirmed by a throwaway console probe that a real
    // spike file should not keep): the DOM removal here does go through
    // `AnimatePresence`'s own exit-tracking (`registered` states get found,
    // `sessions.track()` runs, `state.getFeature('exit').exit()` is called —
    // not bypassed) and NOT synchronously with the `shown.value = false`
    // write. What could NOT be verified in jsdom is that it holds for the
    // full configured 40ms: `visualElement.animationState.setActive('exit',
    // true)` returned an ALREADY-SETTLED promise every time it was probed
    // here, even with keyframes that plainly differ (`{ opacity: [1, 0] }`),
    // i.e. not a `canAnimate()`/no-op false positive. This did not trace to
    // `MotionGlobalConfig` (reset in `afterEach`, and still reproduced), to
    // `prefers-reduced-motion` (motion-dom fails that closed to "not
    // reduced" when `matchMedia` is missing, which jsdom's is), or to the
    // `@vue/test-utils` transition stub (already disabled below). The
    // remaining suspects are all inside `visualElement`'s own state machine,
    // past where this spike's time budget reached bottom. So: this proves
    // AnimatePresence's exit signal is real and load-bearing for removal —
    // not that jsdom honours its configured duration. The real-time hold is
    // what part D's Electron window probe below exists to prove instead.
    const shown = ref(true)
    let exitCompleteCount = 0
    const Harness = buildHarness(shown, () => {
      exitCompleteCount++
    })
    const wrapper = mount(Harness, {
      global: { stubs: { transition: false, 'transition-group': false } }
    })
    await nextTick()
    expect(wrapper.find('div').exists()).toBe(true)

    shown.value = false
    // Nothing has run yet — Vue has not even re-rendered on this reactive
    // write, so the element could not have been removed through ANY path.
    expect(wrapper.find('div').exists()).toBe(true)
    expect(exitCompleteCount).toBe(0)

    const removed = await Promise.race([
      (async () => {
        for (let frame = 0; frame < 120; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          if (!wrapper.find('div').exists()) return true
        }
        return false
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))
    ])
    expect(removed).toBe(true)
    // The removal was AnimatePresence's own doing, signalled through its own
    // callback — not Vue silently dropping the child the instant it left the
    // render output.
    expect(exitCompleteCount).toBe(1)

    wrapper.unmount()
  })
})

describe('motion-v spike: imperative animate() controls contract', () => {
  it('exposes complete()/stop()/cancel() and a thenable; complete() settles it before real time passes', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)

    const controls = animate(el, { opacity: 0 }, { duration: 0.25 })
    expect(typeof controls.complete).toBe('function')
    expect(typeof controls.stop).toBe('function')
    expect(typeof controls.cancel).toBe('function')
    expect(typeof controls.then).toBe('function')

    let settled: 'resolved' | 'rejected' | 'timeout' = 'timeout'
    const race = Promise.race([
      controls.then(
        () => {
          settled = 'resolved'
        },
        () => {
          settled = 'rejected'
        }
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 200))
    ])
    controls.complete()
    await race
    expect(settled).toBe('resolved')

    document.body.removeChild(el)
  })

  /**
   * FINDING (source-traced and reproduced twice, once outside vitest too):
   * in jsdom there is no `Element.animate`, so `animate()` drives the value
   * through `AsyncMotionValueAnimation` wrapping a `JSAnimation`, not the
   * WAAPI-backed `NativeAnimation*` path. `AsyncMotionValueAnimation.stop()`
   * calls `this._animation.stop()` — but neither `JSAnimation` nor its
   * `WithPromise` base defines a `stop()` method at all, and TypeScript's own
   * `.d.ts` for `AnimationPlaybackControls` does not require one either. The
   * call is a no-op whenever `_animation` has not been assigned yet (the
   * keyframe resolver is still pending), which is why it never even throws
   * here. Either way `notifyFinished()` is never called, so `finished` (and
   * therefore the `.then()` thenable) is left pending forever — neither
   * resolved nor rejected. `.cancel()` reaches the same dead end through
   * `this.animation.cancel()`, which itself calls `this.teardown()` and
   * `this.options.onCancel?.()`, neither of which resolves `finished` either.
   *
   * This is a real hang, reproducible without Electron or window occlusion,
   * and it is why T1's bounded adapter must keep resolving its OWN wrapper
   * promise (as `boundedMotion.ts` already does for the WAAPI `.cancel()`
   * case) rather than ever awaiting `controls` itself after calling
   * `.stop()`/`.cancel()` on it.
   */
  it('never settles the thenable through stop() alone (jsdom has no WAAPI-backed animation to resolve it)', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)

    const controls = animate(el, { opacity: 0 }, { duration: 0.25 })
    let settled: 'resolved' | 'rejected' | 'timeout' = 'timeout'
    const race = Promise.race([
      controls.then(
        () => {
          settled = 'resolved'
        },
        () => {
          settled = 'rejected'
        }
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 200))
    ])
    let threw: unknown = null
    try {
      controls.stop()
    } catch (error) {
      threw = error
    }
    await race
    expect(threw).toBeNull()
    expect(settled).toBe('timeout')

    document.body.removeChild(el)
  })

  it('never settles the thenable through cancel() alone either, for the same reason', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)

    const controls = animate(el, { opacity: 0 }, { duration: 0.25 })
    // Give the keyframe resolver a frame to run, so `cancel()` reaches a real
    // `_animation` rather than a no-op on an unset one — the more realistic
    // case for a caller that starts a motion and changes its mind shortly
    // after, which is exactly what `boundedMotion.ts`'s `release()` does.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    let settled: 'resolved' | 'rejected' | 'timeout' = 'timeout'
    const race = Promise.race([
      controls.then(
        () => {
          settled = 'resolved'
        },
        () => {
          settled = 'rejected'
        }
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 200))
    ])
    let threw: unknown = null
    try {
      controls.cancel()
    } catch (error) {
      threw = error
    }
    await race
    expect(threw).toBeNull()
    expect(settled).toBe('timeout')

    document.body.removeChild(el)
  })
})
