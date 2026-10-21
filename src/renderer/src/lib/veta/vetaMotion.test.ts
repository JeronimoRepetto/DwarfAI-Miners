import { describe, expect, it } from 'vitest'
import { createVetaMotion, type VetaMotionTimers } from './vetaMotion'

/*
 * ISSUE-292 (07 S26.13; NFR-TIM-16; `DS/docs/motion.md`, Rules): the Veta window's bounded motion runner. A hand-written
 * element stands in for the browser's Web Animations, and the timers are the test's: a motion ends when the test
 * finishes it or fires its watchdog.
 */

function fakeElement() {
  const animations: Array<{
    keyframes: Keyframe[]
    options: KeyframeAnimationOptions
    cancelled: boolean
    onfinish: (() => void) | null
  }> = []
  const element = {
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = {
        keyframes,
        options,
        cancelled: false,
        onfinish: null as (() => void) | null,
        cancel() {
          animation.cancelled = true
        }
      }
      animations.push(animation)
      return animation
    }
  }
  return { element: element as unknown as Element, animations }
}

function fakeTimers() {
  const live: Array<{ run: () => void; ms: number; on: boolean }> = []
  const timers: VetaMotionTimers = {
    set(run, ms) {
      const t = { run, ms, on: true }
      live.push(t)
      return t
    },
    clear(handle) {
      ;(handle as { on: boolean }).on = false
    }
  }
  return {
    timers,
    armed: () => live.filter((t) => t.on).map((t) => t.ms),
    fire() {
      const timer = live.find((t) => t.on)!
      timer.on = false
      timer.run()
    }
  }
}

describe('createVetaMotion', () => {
  it('[S26.13, NFR-TIM-16] a motion resolves when it finishes, or at its watchdog at delay + duration + 40 ms', async () => {
    const { timers, armed, fire } = fakeTimers()
    const motion = createVetaMotion({ timers, hidden: () => false })
    const { element, animations } = fakeElement()
    let done = false
    void motion
      .run(element, [{ opacity: 0 }, { opacity: 1 }], {
        duration: 360,
        delay: 70,
        easing: 'cubic-bezier(0.2, 0.7, 0.1, 1)',
        fill: 'backwards'
      })
      .then(() => {
        done = true
      })
    expect(animations[0]!.options).toEqual({
      duration: 360,
      delay: 70,
      easing: 'cubic-bezier(0.2, 0.7, 0.1, 1)',
      fill: 'backwards'
    })
    expect(armed()).toEqual([470])
    fire()
    await Promise.resolve()
    expect(done).toBe(true)
    // An entry hands the element back to its own style once it ended.
    expect(animations[0]!.cancelled).toBe(true)

    // An exit that finished holds its last frame until its element is removed.
    let exited = false
    void motion
      .run(element, [{ opacity: 1 }, { opacity: 0 }], {
        duration: 360,
        easing: 'linear',
        fill: 'forwards'
      })
      .then(() => {
        exited = true
      })
    animations[1]!.onfinish!()
    await Promise.resolve()
    expect(exited).toBe(true)
    expect(animations[1]!.cancelled).toBe(false)
    expect(armed()).toEqual([])
  })

  it('[S26.13] the window hidden ends every motion at once, and a hidden window plays none', async () => {
    let hidden = false
    let hide: () => void = () => undefined
    const motion = createVetaMotion({
      timers: fakeTimers().timers,
      hidden: () => hidden,
      onHidden: (listener) => {
        hide = listener
        return () => undefined
      }
    })
    const { element, animations } = fakeElement()
    let done = false
    void motion
      .run(element, [{ opacity: 0 }, { opacity: 1 }], {
        duration: 180,
        easing: 'linear',
        fill: 'backwards'
      })
      .then(() => {
        done = true
      })
    hidden = true
    hide()
    await Promise.resolve()
    expect(done).toBe(true)
    await motion.run(element, [{ opacity: 0 }, { opacity: 1 }], {
      duration: 180,
      easing: 'linear',
      fill: 'backwards'
    })
    expect(animations).toHaveLength(1)
  })
})
