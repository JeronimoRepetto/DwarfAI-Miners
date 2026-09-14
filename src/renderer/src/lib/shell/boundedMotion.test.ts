// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBoundedMotion } from './boundedMotion'
import { PANEL_MOTION_WATCHDOG_MS } from './panelMotion'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Reflect.deleteProperty(document, 'hidden')
})

/** Report the window as Chromium sees it once another program occludes it. */
function occlude(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
}

/**
 * An element whose `animate` hands back an animation this test finishes by
 * hand, the way PanelTransition.test.ts's own harness does — jsdom ships no Web
 * Animations, and a real one would make every case here a race.
 */
function harness(options: { reduced?: boolean; hidden?: boolean; animates?: boolean } = {}) {
  const media = new EventTarget() as MediaQueryList
  Object.defineProperty(media, 'matches', { configurable: true, value: options.reduced ?? false })
  vi.stubGlobal('matchMedia', () => media)
  if (options.hidden !== undefined) occlude(options.hidden)

  const animations: {
    keyframes: Keyframe[]
    timing: KeyframeAnimationOptions
    finish: () => void
    cancel: ReturnType<typeof vi.fn>
  }[] = []
  const element = document.createElement('div')
  if (options.animates !== false) {
    Object.defineProperty(element, 'animate', {
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
  }
  // Created here rather than by the caller so the stubbed matchMedia is the one
  // it reads: the runner asks for the query once, when it is made.
  const motion = createBoundedMotion()
  return { motion, element, animations, media }
}

const RISE: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }]

describe('createBoundedMotion', () => {
  it('runs the panel’s one timing, and reports when the animation says it finished', async () => {
    const test = harness()
    let settled = false
    const done = test.motion.run(test.element, RISE).then(() => {
      settled = true
    })
    expect(test.animations[0]!.keyframes).toEqual(RISE)
    expect(test.animations[0]!.timing).toEqual({
      duration: 250,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      fill: 'both'
    })
    expect(settled).toBe(false)
    test.animations[0]!.finish()
    await done
    expect(settled).toBe(true)
    expect(test.animations[0]!.cancel).toHaveBeenCalledOnce()
    test.motion.dispose()
  })

  it('settles the state the motion ended on BEFORE letting the animation go', async () => {
    // `fill: 'both'` is what holds the last frame, so cancelling first would
    // snap the element back to where it started — one frame of exactly the
    // repaint the motion exists to hide.
    const test = harness()
    const order: string[] = []
    const done = test.motion.run(test.element, RISE, () => order.push('settle'))
    test.animations[0]!.cancel.mockImplementation(() => order.push('cancel'))
    test.animations[0]!.finish()
    await done
    expect(order).toEqual(['settle', 'cancel'])
    test.motion.dispose()
  })

  it('releases a motion whose animation never reports finishing, once the watchdog elapses', async () => {
    // Chromium freezes the document timeline for an occluded window: the last
    // frame lands on the compositor and `finished` never settles (#266).
    vi.useFakeTimers()
    const test = harness()
    let settled = false
    void test.motion.run(test.element, RISE).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(PANEL_MOTION_WATCHDOG_MS)
    expect(settled).toBe(true)
    expect(test.animations[0]!.cancel).toHaveBeenCalledOnce()
    test.motion.dispose()
  })

  it('releases a running motion the moment the window becomes hidden', async () => {
    const test = harness()
    const done = test.motion.run(test.element, RISE)
    occlude(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await done
    expect(test.animations[0]!.cancel).toHaveBeenCalledOnce()
    test.motion.dispose()
  })

  it('releases a running motion when reduced motion is turned on live', async () => {
    const test = harness()
    const done = test.motion.run(test.element, RISE)
    Object.defineProperty(test.media, 'matches', { configurable: true, value: true })
    test.media.dispatchEvent(new Event('change'))
    await done
    expect(test.animations[0]!.cancel).toHaveBeenCalledOnce()
    test.motion.dispose()
  })

  it('reports nothing to animate for reduced motion, a hidden window, or an element that cannot', () => {
    const reduced = harness({ reduced: true })
    expect(reduced.motion.still(reduced.element)).toBe(true)
    reduced.motion.dispose()

    const hidden = harness({ hidden: true })
    expect(hidden.motion.still(hidden.element)).toBe(true)
    hidden.motion.dispose()

    const inert = harness({ animates: false })
    expect(inert.motion.still(inert.element)).toBe(true)
    inert.motion.dispose()

    const ordinary = harness({ hidden: false })
    expect(ordinary.motion.still(ordinary.element)).toBe(false)
    ordinary.motion.dispose()
  })

  it('lets a second motion on one element end the first, rather than racing it', async () => {
    const test = harness()
    let first = false
    void test.motion.run(test.element, RISE).then(() => {
      first = true
    })
    const second = test.motion.run(test.element, RISE)
    await Promise.resolve()
    expect(first).toBe(true)
    expect(test.animations[0]!.cancel).toHaveBeenCalledOnce()
    expect(test.animations[1]!.cancel).not.toHaveBeenCalled()
    test.animations[1]!.finish()
    await second
    test.motion.dispose()
  })

  it('keeps one element’s motion out of another’s, and says which is running', async () => {
    const test = harness()
    const other = document.createElement('div')
    Object.defineProperty(other, 'animate', {
      configurable: true,
      value: Object.getOwnPropertyDescriptor(test.element, 'animate')!.value
    })
    const one = test.motion.run(test.element, RISE)
    const two = test.motion.run(other, RISE)
    expect(test.motion.running(test.element)).toBe(true)
    expect(test.motion.running(other)).toBe(true)
    test.motion.release(test.element)
    await one
    expect(test.motion.running(test.element)).toBe(false)
    expect(test.motion.running(other)).toBe(true)
    expect(test.animations[1]!.cancel).not.toHaveBeenCalled()
    test.motion.release(other)
    await two
    test.motion.dispose()
  })

  it('releases everything on teardown, so an unfinished motion cannot strand its caller', async () => {
    const test = harness()
    const done = test.motion.run(test.element, RISE)
    test.motion.dispose()
    await done
    expect(test.animations[0]!.cancel).toHaveBeenCalledOnce()
    // The listeners go with it: a release after teardown would reach into a
    // component that is no longer there.
    occlude(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(test.animations[0]!.cancel).toHaveBeenCalledOnce()
  })
})
