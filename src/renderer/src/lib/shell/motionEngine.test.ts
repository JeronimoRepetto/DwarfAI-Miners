// @vitest-environment jsdom
/**
 * Pins on `motion-v`'s own `animate()` — the engine `boundedMotion.ts` now runs
 * under the #266 bound, rather than the bound itself (`boundedMotion.test.ts`
 * covers that with a hand-written fake engine, the house idiom for the runner's
 * OWN logic). What belongs here is the contract the runner is built on: that the
 * shapes `panelMotion.ts` and `shellFold.ts` hand it land on the element, and
 * that `cancel()` behaves the way the bound's fix assumes.
 *
 * Moved from the T0 spike (`lib/motion/motionV.spike.test.ts`, #566) once GO was
 * decided — TDD does not apply to a pin on a third-party engine's own contract
 * any more than it did to the spike itself: there is no production behaviour of
 * ours to watch fail first. The one exception, ADDED for #566 T2b: the last two
 * cases in the second `describe` below DO exercise our own code — the engine's
 * deferred render is real (jsdom's `requestAnimationFrame` drives motion-dom's
 * own frameloop, confirmed by running the first of the two RED before deciding
 * its assertion) and `boundedMotion.ts`'s re-apply is what closes it, so those
 * two are an ordinary RED-then-GREEN pair against the real engine, not a pin.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { animate, MotionGlobalConfig } from 'motion-v'
import { createBoundedMotion } from './boundedMotion'

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

/**
 * `cancel()` is the ONE teardown method the bound calls on the controls now
 * (`boundedMotion.ts`) — never `complete()`/`stop()`, the pair an earlier
 * version of this file (and the runner) called in sequence. These two pins
 * replace `complete() settles the thenable` and `never settles the thenable
 * through stop() alone`: the runner no longer calls either, so a pin on them
 * documented nothing it still relies on. What it relies on now is read
 * straight off the two real cases these pins cover.
 */
describe('motion-v engine: the imperative controls contract the bound relies on', () => {
  it('cancel() called before the keyframe resolver ever runs leaves the element untouched and never settles the thenable', async () => {
    // Confirmed against the real engine, not assumed from source: a `cancel()`
    // called in the same synchronous tick as `animate()` — the watchdog and
    // the hidden-window release both can do this, for a run that started an
    // instant before either fired — removes the still-pending keyframe
    // resolver from motion-dom's own queue before it ever reads a keyframe,
    // so nothing is written and the run's own thenable never settles.
    const element = document.createElement('div')
    document.body.append(element)
    const controls = animate(element, { opacity: [1, 0] }, { duration: 0.25, ease: [0.2, 0, 0, 1] })
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
    controls.cancel()
    await race
    expect(element.style.opacity).toBe('')
    expect(settled).toBe('timeout')
    element.remove()
  })

  it('cancel() called mid-flight leaves the element at whatever the JS driver last rendered, not the initial or final keyframe', async () => {
    // jsdom has no `Element.prototype.animate` (`still()`'s own comment in
    // `boundedMotion.ts` reads its mere PRESENCE as the proxy for a real
    // Chromium window), so motion-v's WAAPI check fails here and every run in
    // this environment goes through its JS driver — the one the bound's fix
    // actually depends on.
    //
    // Reading motion-dom's `JSAnimation.cancel()` source alone suggests it
    // writes the INITIAL keyframe (it calls `tick(0)`) — but that value is
    // computed into an internal MotionValue, not flushed to `element.style`
    // synchronously, and `cancel()`'s own `teardown()` stops the driver
    // before any further render can flush it. Measured against the real
    // engine below: the element stays at whatever its LAST rendered frame
    // left it, an arbitrary mid-animation value neither the initial nor the
    // final keyframe. That is exactly why `settle` — never `cancel()` — has
    // to be what decides an element's resting state, and why a caller with
    // no `settle` needs `releaseWritten` to clear whatever is there rather
    // than trust `cancel()` left something clean.
    const element = document.createElement('div')
    document.body.append(element)
    const controls = animate(element, { opacity: [1, 0] }, { duration: 0.25, ease: [0.2, 0, 0, 1] })
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const midFlight = Number(element.style.opacity)
    expect(midFlight).toBeGreaterThan(0)
    expect(midFlight).toBeLessThan(1)
    controls.cancel()
    expect(element.style.opacity).toBe(String(midFlight))
    element.remove()
  })

  /*
   * ADDED for #566 T2b. First written asserting the value survives two
   * frames later — RED, for the reason expected (`skills/tdd`): jsdom's rAF
   * DOES drive motion-dom's own frameloop, so the engine's own deferred
   * render (queued from `cancel()`'s `tick(0)`, see `boundedMotion.ts`'s
   * `MotionControls.cancel`) flushes on the very next frame and overwrites a
   * value written right after `cancel()` with the MotionValue's own current
   * one — `'none'`, because `tick(0)` reset it to the INITIAL keyframe
   * (`x: 0`, which collapses to `none` rather than `translateX(0px)`, the
   * same collapse the instant-animations pin above documents). That failure
   * is the proof this file exists to pin, so the assertion below now pins
   * the OBSERVED behaviour rather than the wished-for one; the case right
   * after it is `boundedMotion.ts`'s own answer to it, against this same
   * real engine.
   */
  it('a value written right after cancel() does NOT survive two frames later — the engine’s own deferred render wins (#566 T2b)', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const controls = animate(element, { x: [0, 120] }, { duration: 0.25, ease: [0.2, 0, 0, 1] })
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    controls.cancel()
    // Stands in for `settle` — the exact write `boundedMotion.ts`'s `run`
    // makes right after `cancel()`.
    element.style.transform = 'translateX(120px)'
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(element.style.transform).toBe('none')
    element.remove()
  })

  /*
   * `boundedMotion.ts`'s own fix for the case above, run against this SAME
   * real engine rather than the hand-written fake `boundedMotion.test.ts`
   * uses for the runner's own logic (`skills/tdd`'s house idiom draws that
   * line: the fake covers the runner's rules, this file covers the engine's
   * contract those rules depend on). No `afterRender` override — this is
   * motion-v's real `frame.postRender`, the same one the case above proved
   * loses the race without it.
   */
  it('boundedMotion’s re-apply survives the engine’s own deferred render, restoring settle after it (#566 T2b)', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    // `still()` reads `element.animate`'s mere presence as its proxy for a
    // real Chromium window (`boundedMotion.ts`'s own comment) — stubbed in
    // exactly as `boundedMotion.test.ts`'s harness does, so this run takes
    // the motion path rather than the instant one.
    Object.defineProperty(element, 'animate', { configurable: true, value: () => undefined })
    const motion = createBoundedMotion()
    const done = motion.run(element, { x: [0, 120] }, () => {
      element.style.transform = 'translateX(120px)'
    })
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    // Ends the run the same way a hidden window or a superseding run would —
    // `cancel()`, then `settle`, then (since #566 T2b) the scheduled re-apply.
    motion.release(element)
    await done
    expect(element.style.transform).toBe('translateX(120px)')
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    // Without the re-apply this would now read `'none'`, exactly like the
    // case above — the engine's own deferred render still happens here too.
    expect(element.style.transform).toBe('translateX(120px)')
    motion.dispose()
    element.remove()
  })
})
