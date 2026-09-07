// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PanelTransition from './PanelTransition.vue'
import { PANEL_MOTION_WATCHDOG_MS } from '../../lib/shell/panelMotion'

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

function harness(reduced = false, axis?: 'horizontal' | 'vertical') {
  const media = new EventTarget() as MediaQueryList
  Object.defineProperty(media, 'matches', { configurable: true, value: reduced })
  vi.stubGlobal('matchMedia', () => media)
  const animations: { finish: () => void; cancel: ReturnType<typeof vi.fn> }[] = []
  const animate = vi.fn(() => {
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const cancel = vi.fn()
    animations.push({ finish, cancel })
    return { finished, cancel }
  })
  const shown = ref(false)
  const leaves: Promise<void>[] = []
  const wrapper = mount(
    defineComponent({
      setup: () => () =>
        h('section', [
          h(
            PanelTransition,
            { axis, onLeave: (leave: Promise<void>) => leaves.push(leave) },
            {
              default: () =>
                shown.value
                  ? h(
                      'div',
                      {
                        key: 'panel',
                        ref: (el) => {
                          if (el)
                            Object.defineProperty(el, 'animate', {
                              configurable: true,
                              value: animate
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
  it('animates entry and retains an inert leaving panel until its exact 250ms animation finishes', async () => {
    const test = harness()
    test.shown.value = true
    await nextTick()
    expect(test.animate).toHaveBeenLastCalledWith(expect.any(Array), {
      duration: 250,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      fill: 'both'
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
    await vi.advanceTimersByTimeAsync(PANEL_MOTION_WATCHDOG_MS)
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

  it('uses the same fixed timing for a vertical dock and releases its leave on teardown', async () => {
    const test = harness(false, 'vertical')
    test.shown.value = true
    await nextTick()
    expect(test.animate).toHaveBeenCalledWith(
      [
        { opacity: 0, transform: 'translateY(12px)' },
        { opacity: 1, transform: 'translate(0, 0)' }
      ],
      { duration: 250, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both' }
    )
    test.shown.value = false
    await nextTick()
    test.wrapper.unmount()
    await test.leaves[0]
    expect(test.animations[1]!.cancel).toHaveBeenCalledOnce()
  })
})
