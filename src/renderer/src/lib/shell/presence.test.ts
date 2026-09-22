// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MotionConfig, motion } from 'motion-v'
import { PANEL_MOTION_Y } from './panelMotion'
import {
  fadeVariants,
  popVariants,
  pressHoverUnless,
  pressHoverVariants,
  REDUCED_MOTION_TRANSITION
} from './presence'

describe('presence vocabulary: the shapes #566 T3 hands every popup/tooltip surface', () => {
  it('popVariants rises PANEL_MOTION_Y and fades, both ways', () => {
    expect(popVariants).toEqual({
      initial: { opacity: 0, y: PANEL_MOTION_Y },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: PANEL_MOTION_Y }
    })
  })

  it('fadeVariants only ever fades — no travel, for the surfaces that never moved', () => {
    expect(fadeVariants).toEqual({
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 }
    })
  })

  // "No transition anywhere: motion-v decides" (#566 T2's own ruling, extended
  // here) — a literal `in` check rather than trusting the object shape above,
  // so a future edit that quietly adds one back is caught by this test and
  // not only by the assertion it would also break.
  it('authors no transition on either shape — motion-v decides, per #566', () => {
    expect('transition' in popVariants).toBe(false)
    expect('transition' in fadeVariants).toBe(false)
  })
})

/*
 * ADDED for #566 T4: the press/hover vocabulary. Its own describe rather than a
 * fourth case above, because it is a different KIND of shape — the two above are
 * presence (what a surface does on the way in and out, driven by
 * `AnimatePresence`), and this one is gesture (what a control does under a
 * pointer, driven by motion-v's own hover/press features). They share a file
 * because they share the rule that made the file: one vocabulary, imported, so
 * a control never carries a literal of its own.
 */
describe('press/hover vocabulary: the shape #566 T4 hands every panel control', () => {
  it('grows under a hover and gives under a press, touching nothing but scale', () => {
    expect(pressHoverVariants).toEqual({
      whileHover: { scale: 1.03 },
      whilePress: { scale: 0.96 }
    })
  })

  /*
   * The prop names are motion-v's own (`state/utils/variant-props.mjs` lists
   * `whileHover` and `whilePress` among the variant props its components read),
   * which is what lets a control spread the whole shape with one
   * `v-bind="pressHoverVariants"` — the same idiom `popVariants` already has on
   * the modal roots. A rename upstream, or a well-meaning `whileTap` here,
   * would leave every control silently gestureless, so the keys are pinned as
   * keys and not only through the value assertion above.
   */
  it('uses the prop names motion-v actually reads, so one v-bind reaches both', () => {
    expect(Object.keys(pressHoverVariants).sort()).toEqual(['whileHover', 'whilePress'])
  })

  // The same "motion-v decides" ruling the two presence shapes are held to
  // (#566 T2, extended through T3): no duration and no curve is authored here
  // either, and a control that wants one is a design decision, not a literal.
  it('authors no transition — motion-v decides, per #566', () => {
    expect('transition' in pressHoverVariants).toBe(false)
    expect('transition' in pressHoverVariants.whileHover).toBe(false)
    expect('transition' in pressHoverVariants.whilePress).toBe(false)
  })
})

/*
 * The finding behind `REDUCED_MOTION_TRANSITION` (`presence.ts`'s own module
 * header carries the full why). Pinned against the real engine, not assumed
 * from reading `motion-dom`'s source alone — the same discipline
 * `motionEngine.test.ts` holds itself to for every fact it pins about a
 * third-party contract.
 */
describe('MotionConfig reducedMotion="always": what it actually skips', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * A minimal stand-in for what `App.vue`/`MessagePanelWindow.vue` wire at
   * their own root: `<MotionConfig>` over a `motion.div` that authors no
   * `transition` of its own, exactly like `popVariants`/`fadeVariants`.
   */
  function harness(reducedMotion: 'always' | 'never', transition?: { duration: number }) {
    return defineComponent({
      components: { MotionConfig, MDiv: motion.div },
      setup() {
        return { reducedMotion, transition }
      },
      // A real compiled template rather than raw `h()` calls — `MotionConfig`
      // provides its context in `setup()`, and a hand-written slot function
      // passed to `h()` is never wrapped in Vue's own `withCtx`, the thing an
      // SFC's compiler adds so a slot's `inject()` sees the component that
      // RENDERED it rather than the component that AUTHORED it. That gap cost
      // one wrong RED here (opacity stuck at 0 forever — the config never
      // reached the child at all) before this became a template.
      template: `<MotionConfig :reduced-motion="reducedMotion" :transition="transition">
        <MDiv :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" />
      </MotionConfig>`
    })
  }

  /*
   * The fix, proven the same way `App.vue`/`MessagePanelWindow.vue` actually
   * apply it: `REDUCED_MOTION_TRANSITION` handed to `<MotionConfig>` itself,
   * never restated on the `motion.div` — motion-v's own prop resolution
   * (`resolve-motion-props.mjs`: `props.transition ?? config.transition`) is
   * what is under test here, not a transition this test authors twice.
   *
   * Ordered BEFORE the finding below on purpose, and both real time rather
   * than `vi.useFakeTimers()`: motion-dom's own frame batcher is one module-
   * level singleton, and a fake-timer-driven animation run to completion in
   * an EARLIER test in this same file still left the batcher unable to drive
   * a later one — passed alone under `vitest -t`, failed as part of the file,
   * in both orders tried. Real time for both sidesteps it, and motion-v's own
   * JS driver runs a genuine `requestAnimationFrame` loop either way
   * (`motionEngine.test.ts`'s own real-timer cases rely on the same fact).
   */
  it('lands opacity in one frame once the root hands MotionConfig REDUCED_MOTION_TRANSITION', async () => {
    const wrapper = mount(harness('always', REDUCED_MOTION_TRANSITION))
    const el = wrapper.find('div').element as HTMLElement
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(el.style.opacity).toBe('1')
    wrapper.unmount()
  })

  /*
   * RED first, against the real engine: this is the finding, not a pin on our
   * own code. Real time, and polled with successive animation frames rather
   * than a fixed wait: motion-dom's default `ease` for opacity is 300ms
   * (`motionTiming.ts` quotes the same constant from its own source), and a
   * poll that gives up once it sees a value strictly between 0 and 1 proves
   * the animation ran without pinning this test to that exact duration —
   * a number this file does not own and motion-dom could change under it.
   */
  it('still animates opacity over its ordinary default duration — "always" only skips positional keys (x/y/width/height/…), never opacity', async () => {
    const wrapper = mount(harness('always'))
    const el = wrapper.find('div').element as HTMLElement
    let midFlight = Number(el.style.opacity)
    for (let frame = 0; frame < 30 && !(midFlight > 0 && midFlight < 1); frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      midFlight = Number(el.style.opacity)
    }
    expect(midFlight).toBeGreaterThan(0)
    expect(midFlight).toBeLessThan(1)
    wrapper.unmount()
  })
})

/**
 * A finding, not a pin — and it does NOT get its own passing test, because it
 * is a gap this suite cannot close, not a fact it can rely on.
 *
 * `AnimatePresence`'s exit-hold (`use-presence-container.mjs`'s `exit()`,
 * `exit-session.mjs`'s `track()`) waits on `state.getFeature('exit')?.exit()`
 * — `features/exit/exit.mjs` — whose promise only resolves for real if
 * `state.visualElement.animationState.setActive('exit', true)` actually
 * starts an animation. `features/animation/animation.mjs`'s `AnimationFeature
 * .mount()` calls that SAME `setActive('exit', true)` a first time, at MOUNT,
 * whenever `isHidden(element)` — `utils/is-hidden.mjs` — answers true:
 * `element.offsetParent === null && position !== 'fixed'`. jsdom lays out
 * nothing at all, so `offsetParent` is `null` for every element it ever
 * creates, on any node, hidden or not (confirmed here: stubbing
 * `HTMLElement.prototype.offsetParent` to a truthy value changed nothing,
 * which said this was not the only precondition tripping the same guard).
 * `animation-state.mjs`'s own `setActive`: `if (state[type].isActive ===
 * isActive) return Promise.resolve()` — an EARLY exit call already latched
 * `isActive` true, so the REAL exit call later finds nothing changed and
 * resolves on the spot. A popup mounted in jsdom is READ as already exiting
 * from the moment it appears.
 *
 * This is an environment gap, not a defect in what T3 wrote: the ENTER
 * animation is real and pinned above (jsdom's lack of `Element.animate`
 * forces motion-v's own JS driver, which still runs over genuine frames —
 * `motionEngine.test.ts` already established this for the bounded runner).
 * Only `AnimatePresence`'s EXIT path depends on a layout primitive jsdom
 * never implements. Surfaced rather than worked around: `MinesPanel.test.ts`
 * and `MapView.test.ts` verify each wrapped popup opens and closes on the
 * expected trigger (the assertion the design and #506/#538/#169/#348 all
 * actually care about); real Electron confirmation that the exit genuinely
 * fades rather than snapping is `T5`'s job, per the parent task document.
 */

/*
 * ADDED for #566 T4 follow-up: a DISABLED control must answer nothing.
 *
 * What the helper HANDS BACK is here, beside the vocabulary it withholds. What
 * the engine then DOES with that — the finding that made the helper necessary —
 * is `pressHoverGesture.test.ts`, kept apart because it needs a mounted
 * component and this file already has one for `MotionConfig`.
 */
describe('pressHoverUnless: a disabled control answers nothing', () => {
  it('hands back the shared variants themselves while the control can be pressed', () => {
    expect(pressHoverUnless(false)).toBe(pressHoverVariants)
  })

  // `in` rather than a value check, because the contract is that the props are
  // ABSENT: `{ whileHover: undefined }` would satisfy a value assertion while
  // still being a different thing to spread onto a component.
  it('hands back neither gesture prop once the control is disabled', () => {
    const bound = pressHoverUnless(true)
    expect('whileHover' in bound).toBe(false)
    expect('whilePress' in bound).toBe(false)
  })
})
