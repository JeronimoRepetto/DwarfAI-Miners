// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { defineComponent, ref, type Ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { motion } from 'motion-v'
import { pressHoverUnless, pressHoverVariants } from './presence'

/**
 * What the ENGINE does with `pressHoverVariants` on a disabled control (#566 T4
 * follow-up) — the finding `pressHoverUnless` exists for, and the proof that
 * withholding the props is enough to answer it.
 *
 * Pinned against the real engine rather than read off its source, the same
 * discipline `motionEngine.test.ts` holds itself to for every third-party fact
 * it relies on: what the source says and what the browser does are two claims,
 * and only one of them ships.
 *
 * Its own file rather than a third component inside `presence.test.ts`, which
 * already keeps one for `MotionConfig` — `vue/one-component-per-file` is right
 * that a test file holding several is a file with several subjects in it, and
 * "what the vocabulary IS" and "what the engine DOES with it" are two.
 *
 * jsdom lays out nothing, but it dispatches the event and motion-v's own JS
 * driver writes the transform over genuine `requestAnimationFrame` frames,
 * which is all these need.
 */
describe('a disabled motion.button under a hover', () => {
  /** One button, its disabled state and its bound gesture both reactive. */
  const GestureButton = defineComponent({
    components: { MButton: motion.button },
    props: {
      busy: { type: Boolean, required: true },
      // Bound raw in one case and through the helper in the other, so the two
      // paths are the same component under the same driver and differ only in
      // the thing under test.
      bound: { type: Object, required: true }
    },
    template: `<MButton :disabled="busy" v-bind="bound">x</MButton>`
  })

  async function settle(): Promise<void> {
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }

  function mountButton(busy: boolean, bound: Ref<Record<string, unknown>>) {
    const wrapper = mount(GestureButton, {
      props: { busy, bound: bound.value },
      attachTo: document.body
    })
    return { wrapper, element: wrapper.find('button').element as HTMLButtonElement }
  }

  const GROWN = `scale(${pressHoverVariants.whileHover.scale})`

  /*
   * The defect itself, and the reason for everything else here: motion-dom's
   * `hover()` (`gestures/hover.mjs`) attaches a bare `pointerenter` listener
   * and never reads `element.disabled`, and Chromium dispatches pointer events
   * at disabled form controls regardless. A control that refuses a press still
   * grew under the cursor.
   */
  it('grows when the variants are bound raw, disabled or not', async () => {
    const bound = ref<Record<string, unknown>>({ ...pressHoverVariants })
    const { wrapper, element } = mountButton(true, bound)

    expect(element.disabled).toBe(true)
    element.dispatchEvent(new window.PointerEvent('pointerenter'))
    await settle()

    expect(element.style.transform).toBe(GROWN)
    wrapper.unmount()
  })

  it('stays still when the same button is bound through pressHoverUnless', async () => {
    const bound = ref<Record<string, unknown>>({ ...pressHoverUnless(true) })
    const { wrapper, element } = mountButton(true, bound)

    expect(element.disabled).toBe(true)
    element.dispatchEvent(new window.PointerEvent('pointerenter'))
    await settle()

    expect(element.style.transform).toBe('')
    wrapper.unmount()
  })

  /*
   * The case the two above cannot reach, and the one most of these controls
   * actually live in: Add, Remove and Open are all LIVE when they mount and go
   * disabled while the work runs.
   *
   * It needs its own proof because motion-v's `HoverGesture.update()`
   * (`features/gestures/hover/index.mjs`) only ever ADDS a registration — it
   * never tears one down when `whileHover` goes away, so the `pointerenter`
   * listener installed while the control was live is still attached after it
   * goes disabled. Withholding the prop is nevertheless enough: the listener
   * fires into an option that is no longer there. Asserted rather than assumed,
   * because "the listener outlived the prop" is exactly the shape a silent hole
   * takes.
   */
  it('stays still after going disabled, though its hover listener outlives the prop', async () => {
    const busy = ref(false)
    const wrapper = mount(GestureButton, {
      props: { busy: busy.value, bound: pressHoverUnless(busy.value) },
      attachTo: document.body
    })
    const element = wrapper.find('button').element as HTMLButtonElement

    // Live first, so the gesture really does register and really does grow it.
    element.dispatchEvent(new window.PointerEvent('pointerenter'))
    await settle()
    expect(element.style.transform).toBe(GROWN)
    element.dispatchEvent(new window.PointerEvent('pointerleave'))
    await settle()

    busy.value = true
    await wrapper.setProps({ busy: busy.value, bound: pressHoverUnless(busy.value) })
    expect(element.disabled).toBe(true)

    element.dispatchEvent(new window.PointerEvent('pointerenter'))
    await settle()
    // Whichever way the engine spells "at rest" — it never spells it as a grow.
    expect(['', 'none']).toContain(element.style.transform)

    wrapper.unmount()
  })
})
