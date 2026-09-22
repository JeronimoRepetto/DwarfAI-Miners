// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultTransition } from 'motion-v'
import type { DOMKeyframesDefinition } from 'motion-v'
import { createBoundedMotion, type MotionAnimate } from './boundedMotion'
import { motionBoundMs, type MotionTransition } from './motionTiming'

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
 * Which CSS property each motion-v keyframe key maps onto, mirroring what the
 * real engine actually writes (`motionEngine.test.ts` pins that separately):
 * `x`/`y` both collapse onto `transform`, never their own property.
 */
const STYLE_PROPERTY: Record<string, string> = {
  opacity: 'opacity',
  x: 'transform',
  y: 'transform',
  clipPath: 'clipPath'
}

/**
 * A hand-written stand-in for motion-v's own `animate()` — AMENDED for #566
 * (was: stubbing `element.animate`, WAAPI's own entry point, which the runner
 * no longer calls), and AMENDED again for the `cancel()`-first fix below (was:
 * a `complete`/`stop` pair, mirroring a `MotionControls` shape the runner no
 * longer has). `createBoundedMotion({ animate })` is the seam: tests hand it
 * this fake, production hands it nothing and gets the real motion-v import
 * instead (`motionEngine.test.ts` pins the real one).
 *
 * AMENDED again for #566: no `options` argument any more — the runner passes
 * `animate()` no transition at all now, so a fake that recorded one would be
 * recording something the real call site never sends.
 *
 * AMENDED again for #464 (correction to T2): a fourth, OPTIONAL `transition`
 * argument is back — `boundedMotion.run`'s own new optional parameter,
 * forwarded straight to `animate()` when a caller (`useShellFold.carry()`)
 * gives one, so the fold's rail can share the clip's own transition instead
 * of motion-v picking a different default for each. Recorded here (possibly
 * `undefined`) so the transition test below can assert exactly what the
 * engine received.
 *
 * `cancel()` writes the INITIAL keyframe by default — mirroring the stronger
 * of the two real shapes read from motion-dom's own source (`JSAnimation`'s
 * `cancel()` calls `tick(0)`): a WAAPI `cancel()` that writes nothing is a
 * no-op the runner does not depend on either way, but one that DOES write has
 * to run before `settle`, never after, or it would stomp the caller's answer.
 * `finish()` writes the FINAL keyframe and settles the engine's own thenable,
 * the way a run that completes on its own timeline does.
 */
function fakeEngine() {
  const runs: {
    element: Element
    keyframes: DOMKeyframesDefinition
    transition: MotionTransition | undefined
    finish: () => void
    cancel: ReturnType<typeof vi.fn>
  }[] = []
  const animate: MotionAnimate = (element, keyframes, transition) => {
    let resolveFinished!: () => void
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve
    })
    const writeFrame = (which: 'initial' | 'final'): void => {
      const style = (element as HTMLElement).style
      for (const [key, value] of Object.entries(keyframes)) {
        const property = STYLE_PROPERTY[key]
        if (property === undefined || !Array.isArray(value)) continue
        const frame = which === 'final' ? value[value.length - 1] : value[0]
        const written =
          key === 'x' || key === 'y'
            ? `translate${key.toUpperCase()}(${String(frame)}px)`
            : String(frame)
        style.setProperty(property, written)
      }
    }
    const cancel = vi.fn(() => writeFrame('initial'))
    runs.push({
      element,
      keyframes,
      transition,
      finish: () => {
        writeFrame('final')
        resolveFinished()
      },
      cancel
    })
    return {
      cancel,
      then: (onResolve: () => void, onReject?: () => void) => finished.then(onResolve, onReject)
    }
  }
  return { animate, runs }
}

function harness(options: { reduced?: boolean; hidden?: boolean; animates?: boolean } = {}) {
  const media = new EventTarget() as MediaQueryList
  Object.defineProperty(media, 'matches', { configurable: true, value: options.reduced ?? false })
  vi.stubGlobal('matchMedia', () => media)
  if (options.hidden !== undefined) occlude(options.hidden)

  const element = document.createElement('div')
  if (options.animates !== false) {
    // `still()` reads `element.animate` only as the app's proxy for "a real
    // Chromium window" (motion-v needs no such method to run) — jsdom has
    // none, so every case that wants the motion PATH stubs one in, exactly as
    // before.
    Object.defineProperty(element, 'animate', { configurable: true, value: () => undefined })
  }
  const engine = fakeEngine()
  const motion = createBoundedMotion({ animate: engine.animate })
  return { motion, element, runs: engine.runs, media }
}

const RISE: DOMKeyframesDefinition = { opacity: [0, 1] }

describe('createBoundedMotion', () => {
  it('runs the panel’s one timing, and reports when the engine says it finished', async () => {
    const test = harness()
    let settled = false
    const done = test.motion.run(test.element, RISE).then(() => {
      settled = true
    })
    // No transition is asked for any more (#566) — the runner hands motion-v
    // only the keyframes, and lets `getDefaultTransition` pick.
    expect(test.runs[0]!.keyframes).toEqual(RISE)
    expect(settled).toBe(false)
    test.runs[0]!.finish()
    await done
    expect(settled).toBe(true)
    // `cancel()` is the only teardown method the bound calls on the
    // controls — it discards the engine's own effect (and any still-pending
    // keyframe resolver) before a `finish` event the engine fires later could
    // ever land, which the old `complete()`/`stop()` pair never guaranteed.
    expect(test.runs[0]!.cancel).toHaveBeenCalledOnce()
    test.motion.dispose()
  })

  it('cancels the engine first, then settles the state, then lets the run go, in that order', async () => {
    // `cancel()` runs FIRST, always: on the WAAPI path it discards the effect
    // before a `finish` event a hidden window's frozen timeline delayed can
    // ever land after the fact; on the JS driver it can leave the element at
    // an arbitrary mid-animation frame (`motionEngine.test.ts` pins the real
    // one). Either way `settle` has to run right after it, never before, or
    // the caller's answer for this element would be overwritten by whatever
    // `cancel()` itself just left there.
    const test = harness()
    const order: string[] = []
    const done = test.motion.run(test.element, RISE, () => order.push('settle'))
    test.runs[0]!.cancel.mockImplementation(() => order.push('cancel'))
    test.runs[0]!.finish()
    await done
    // `finish()` resolves the engine's OWN thenable directly (the way a real
    // run finishing on its own does), so the bound's own `cancel()` call —
    // made from inside the SAME closure that ran `settle` — is what shows up
    // here, not the fake's `finish` helper.
    expect(order).toEqual(['cancel', 'settle'])
    test.motion.dispose()
  })

  it('hands the properties the engine wrote back to the stylesheet when the caller has no settle', async () => {
    const test = harness()
    const done = test.motion.run(test.element, RISE)
    test.runs[0]!.finish()
    await done
    // `finish()` writes RISE's final keyframe (`opacity: '1'`); `cancel()`
    // then overwrites it with the INITIAL keyframe (`'0'`, this fake's
    // default). `releaseWritten` clears the property outright regardless of
    // which write left it there — proving it does not merely revert the
    // engine's last value, it hands the property back to the stylesheet.
    expect(test.element.style.opacity).toBe('')
    test.motion.dispose()
  })

  it('leaves whatever cancel() left on the element alone once the caller has a settle, whatever that is', async () => {
    // `finish()` writes RISE's final keyframe (`opacity: '1'`) and settles the
    // engine's own thenable; `cancel()` then overwrites it with the INITIAL
    // keyframe (`'0'`), mirroring motion-dom's own JS driver (`tick(0)`,
    // `motionEngine.test.ts` pins the real engine doing something similar).
    // The caller's own `settle` here is a no-op, so `cancel()`'s write is
    // what stays — proving a caller that owns `settle` really does own
    // EVERY property this run touches: the runner never calls
    // `releaseWritten` once `settle` is defined, no matter what either write
    // left behind.
    const test = harness()
    const done = test.motion.run(test.element, RISE, () => undefined)
    test.runs[0]!.finish()
    await done
    expect(test.element.style.opacity).toBe('0')
    test.motion.dispose()
  })

  it('cancels then settles, in that order, once the watchdog elapses on an engine that never reports finishing', async () => {
    // Chromium freezes the document timeline for an occluded window: the last
    // frame lands on the compositor and `finished` never settles (#266). The
    // watchdog ends the run anyway — `cancel()` first, so nothing the engine
    // might still deliver later can land after `settle` decided the state.
    vi.useFakeTimers()
    const test = harness()
    let settled = false
    const order: string[] = []
    void test.motion
      .run(test.element, RISE, () => order.push('settle'))
      .then(() => {
        settled = true
      })
    test.runs[0]!.cancel.mockImplementation(() => order.push('cancel'))
    await vi.advanceTimersByTimeAsync(motionBoundMs(RISE))
    expect(settled).toBe(true)
    expect(order).toEqual(['cancel', 'settle'])
    expect(test.runs[0]!.cancel).toHaveBeenCalledOnce()
    test.motion.dispose()
  })

  it('cancels then settles, in that order, the moment the window becomes hidden', async () => {
    const test = harness()
    const order: string[] = []
    const done = test.motion.run(test.element, RISE, () => order.push('settle'))
    test.runs[0]!.cancel.mockImplementation(() => order.push('cancel'))
    occlude(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await done
    expect(order).toEqual(['cancel', 'settle'])
    expect(test.runs[0]!.cancel).toHaveBeenCalledOnce()
    test.motion.dispose()
  })

  it('releases a running motion when reduced motion is turned on live', async () => {
    const test = harness()
    const done = test.motion.run(test.element, RISE)
    Object.defineProperty(test.media, 'matches', { configurable: true, value: true })
    test.media.dispatchEvent(new Event('change'))
    await done
    expect(test.runs[0]!.cancel).toHaveBeenCalledOnce()
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

  /*
   * ADDED for #396. `sceneMotion` has owned the app's one reduced-motion query
   * since #71 — "the prefersReducedMotion query, not a fifth mechanism" — and
   * asking it rather than calling `matchMedia` here brings its tolerance with
   * it: answering the preference is what every platform manages, watching it
   * change is not, and one that cannot watch used to take the whole panel down
   * on a listener it does not have.
   */
  it('keeps the answer it started with where the platform cannot watch the preference change', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const element = document.createElement('div')
    Object.defineProperty(element, 'animate', { configurable: true, value: () => undefined })
    const motion = createBoundedMotion()
    expect(motion.still(element)).toBe(true)
    expect(() => motion.dispose()).not.toThrow()
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
    expect(test.runs[0]!.cancel).toHaveBeenCalledOnce()
    expect(test.runs[1]!.cancel).not.toHaveBeenCalled()
    test.runs[1]!.finish()
    await second
    test.motion.dispose()
  })

  it('keeps one element’s motion out of another’s, and says which is running', async () => {
    const test = harness()
    const other = document.createElement('div')
    Object.defineProperty(other, 'animate', { configurable: true, value: () => undefined })
    const one = test.motion.run(test.element, RISE)
    const two = test.motion.run(other, RISE)
    expect(test.motion.running(test.element)).toBe(true)
    expect(test.motion.running(other)).toBe(true)
    test.motion.release(test.element)
    await one
    expect(test.motion.running(test.element)).toBe(false)
    expect(test.motion.running(other)).toBe(true)
    expect(test.runs[1]!.cancel).not.toHaveBeenCalled()
    test.motion.release(other)
    await two
    test.motion.dispose()
  })

  it('releases everything on teardown, so an unfinished motion cannot strand its caller', async () => {
    const test = harness()
    const done = test.motion.run(test.element, RISE)
    test.motion.dispose()
    await done
    expect(test.runs[0]!.cancel).toHaveBeenCalledOnce()
    // The listeners go with it: a release after teardown would reach into a
    // component that is no longer there.
    occlude(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(test.runs[0]!.cancel).toHaveBeenCalledOnce()
  })

  /*
   * ADDED for #464 (correction to T2). `run`'s own optional fourth argument,
   * forwarded straight to the engine: `useShellFold.carry()` is the one
   * caller that gives one, so its rail can share the clip's transition
   * rather than let motion-v pick the rail's own default spring.
   */
  it('forwards an explicit transition straight to the engine, and arms the watchdog off it', async () => {
    const test = harness()
    const explicitTransition = getDefaultTransition('clipPath', {
      keyframes: ['a', 'b'] as unknown as number[]
    })
    const done = test.motion.run(test.element, RISE, undefined, explicitTransition)
    expect(test.runs[0]!.transition).toBe(explicitTransition)
    test.runs[0]!.finish()
    await done
    test.motion.dispose()
  })

  it('bounds a watchdog by the explicit transition rather than the keyframes’ own default', async () => {
    vi.useFakeTimers()
    const test = harness()
    // RISE (`{ opacity: [0, 1] }`) resolves to the flat 300ms ease (350ms
    // bound) on its own default — a discriminating test needs a transition
    // that genuinely disagrees, or a bug that silently ignored the fourth
    // argument would pass all the same. `x`'s own default spring, applied to
    // RISE's tiny opacity delta (a "granular" spring, motion-dom's own
    // tighter resting threshold for it), settles at 450ms — measured against
    // the real engine, not assumed: `motionBoundMs(RISE, explicitSpring)` is
    // 500, genuinely later than RISE's own 350.
    const explicitSpring = getDefaultTransition('x', { keyframes: [12, 0] })
    const explicitBound = motionBoundMs(RISE, explicitSpring)
    const defaultBound = motionBoundMs(RISE)
    expect(explicitBound).toBeGreaterThan(defaultBound)
    let settled = false
    void test.motion.run(test.element, RISE, undefined, explicitSpring).then(() => {
      settled = true
    })
    // Not yet settled at RISE's own would-be bound: a run that silently
    // ignored the explicit transition would already be done here.
    await vi.advanceTimersByTimeAsync(defaultBound)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(explicitBound - defaultBound)
    expect(settled).toBe(true)
    test.motion.dispose()
  })
})
