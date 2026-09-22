// @vitest-environment jsdom
/**
 * Pins on `motion-v`'s own `animate()` — the engine `boundedMotion.ts` now runs
 * under the #266 bound, rather than the bound itself (`boundedMotion.test.ts`
 * covers that with a hand-written fake engine, the house idiom for the runner's
 * OWN logic). What belongs here is the contract the runner is built on: that the
 * shapes `panelMotion.ts` and `shellFold.ts` hand it land on the element, and
 * that `complete()`/`stop()` behave the way the bound assumes.
 *
 * Moved from the T0 spike (`lib/motion/motionV.spike.test.ts`, #566) once GO was
 * decided — TDD does not apply to a pin on a third-party engine's own contract
 * any more than it did to the spike itself: there is no production behaviour of
 * ours to watch fail first.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { animate, MotionGlobalConfig } from 'motion-v'

// `MotionGlobalConfig` is plain, module-scoped, mutable state with no reset API
// of its own (found in the T0 spike) — a value set in one test bleeds into the
// next one here otherwise.
afterEach(() => {
  MotionGlobalConfig.instantAnimations = false
  MotionGlobalConfig.skipAnimations = false
})

describe('motion-v engine: lands the final frame', () => {
  it('writes opacity, the x transform shortcut and clip-path onto the element under instantAnimations', async () => {
    // `instantAnimations` is what `useShellFold`'s own future tests (T2+) and a
    // real Electron window never get — this is the one place the engine's own
    // value-writing is pinned without a real 250ms to wait out.
    MotionGlobalConfig.instantAnimations = true
    const element = document.createElement('div')
    document.body.append(element)
    const controls = animate(
      element,
      {
        opacity: [0, 1],
        x: [12, 0],
        clipPath: [
          'inset(0px 0px 0px 0px round 12px)',
          'inset(0px 0px 0px calc(100% - 438px) round 12px)'
        ]
      },
      { duration: 0.25, ease: [0.2, 0, 0, 1] }
    )
    await controls
    expect(element.style.opacity).toBe('1')
    // `x: 0` collapses to `none` rather than `translateX(0px)` — the engine's
    // own choice, and exactly why the runner cannot assert a literal transform
    // string the way the WAAPI harnesses used to.
    expect(element.style.transform).toBe('none')
    // The `calc()` inside `inset(...)` — the one structural risk named in the
    // design — resolves to the exact target string rather than failing to
    // interpolate or landing short of it.
    expect(element.style.clipPath).toBe('inset(0px 0px 0px calc(100% - 438px) round 12px)')
    element.remove()
  })
})

describe('motion-v engine: the imperative controls contract the bound relies on', () => {
  it('complete() settles the thenable before real time passes', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const controls = animate(element, { opacity: [0, 1] }, { duration: 0.25, ease: [0.2, 0, 0, 1] })
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
    element.remove()
  })

  /**
   * `stop()` is the ONLY teardown method the bound calls on the controls
   * (never `cancel()` — the injected engine's own minimal type has no room for
   * it), and it never settles the thenable on its own: the runner's own
   * promise, resolved from `settle`, is what a caller actually waits on.
   */
  it('never settles the thenable through stop() alone', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const controls = animate(element, { opacity: [0, 1] }, { duration: 0.25, ease: [0.2, 0, 0, 1] })
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
    element.remove()
  })
})
