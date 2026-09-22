// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DOMKeyframesDefinition } from 'motion-v'
import { createBoundedMotion, type MotionAnimate } from './boundedMotion'
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
 * no longer calls). `createBoundedMotion({ animate })` is the seam: tests hand
 * it this fake, production hands it nothing and gets the real motion-v import
 * instead (`motionEngine.test.ts` pins the real one).
 *
 * `finish()` writes the FINAL keyframe value onto the element the way the real
 * engine does — motion-v writes its own final frame straight into inline
 * style rather than compositing a discardable WAAPI effect on top of it — so a
 * test can tell whether the runner handed a property back to the stylesheet
 * afterwards or left the engine's own value sitting there.
 */
function fakeEngine() {
  const runs: {
    element: Element
    keyframes: DOMKeyframesDefinition
    options: { duration: number; ease: unknown }
    finish: () => void
    complete: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
  }[] = []
  const animate: MotionAnimate = (element, keyframes, options) => {
    let resolveFinished!: () => void
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve
    })
    const writeFinalFrame = (): void => {
      const style = (element as HTMLElement).style
      for (const [key, value] of Object.entries(keyframes)) {
        const property = STYLE_PROPERTY[key]
        if (property === undefined || !Array.isArray(value)) continue
        const last = value[value.length - 1]
        const written =
          key === 'x' || key === 'y'
            ? `translate${key.toUpperCase()}(${String(last)}px)`
            : String(last)
        style.setProperty(property, written)
      }
    }
    const complete = vi.fn(() => {
      writeFinalFrame()
      resolveFinished()
    })
    const stop = vi.fn()
    runs.push({
      element,
      keyframes,
      options,
      finish: () => {
        writeFinalFrame()
        resolveFinished()
      },
      complete,
      stop
    })
    return {
      complete,
      stop,
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
    expect(test.runs[0]!.keyframes).toEqual(RISE)
    expect(test.runs[0]!.options).toEqual({ duration: 0.25, ease: [0.2, 0, 0, 1] })
    expect(settled).toBe(false)
    test.runs[0]!.finish()
    await done
    expect(settled).toBe(true)
    // `stop()` is the only teardown method the bound calls on the controls —
    // never `cancel()`, which the injected engine's own minimal type has no
    // room for.
    expect(test.runs[0]!.stop).toHaveBeenCalledOnce()
    test.motion.dispose()
  })

  it('tries the engine’s own complete() first, then settles the state, then lets the run go, in that order', async () => {
    // Best-effort: the T0 probe found `complete()` can land a value late
    // rather than never once the window is hidden, and costs nothing once the
    // engine already finished on its own. `settle` is what actually
    // guarantees the state either way, and still has to run before `stop()`
    // for the reason it always did — cancelling first would have been one
    // frame of exactly the repaint the motion exists to hide.
    const test = harness()
    const order: string[] = []
    const done = test.motion.run(test.element, RISE, () => order.push('settle'))
    test.runs[0]!.complete.mockImplementation(() => order.push('complete'))
    test.runs[0]!.stop.mockImplementation(() => order.push('stop'))
    test.runs[0]!.finish()
    await done
    // `finish()` resolves the engine's OWN thenable directly (the way a real
    // run finishing on its own does), so the bound's best-effort `complete()`
    // call — made from inside the SAME closure that ran `settle` — is what
    // shows up here, not the fake's `finish` helper.
    expect(order).toEqual(['complete', 'settle', 'stop'])
    test.motion.dispose()
  })

  it('hands the properties the engine wrote back to the stylesheet when the caller has no settle', async () => {
    const test = harness()
    const done = test.motion.run(test.element, RISE)
    test.runs[0]!.finish()
    await done
    expect(test.element.style.opacity).toBe('')
    test.motion.dispose()
  })

  it('leaves the engine’s own written properties alone once the caller has a settle, whatever it wrote', async () => {
    // Motion-v writes its final frame straight into inline style rather than
    // compositing a WAAPI effect `cancel()` could drop for free — so a caller
    // that owns `settle` has to own everything this run touched, the same
    // contract `useShellFold` and `MessagePanelWindow` already keep.
    const test = harness()
    const done = test.motion.run(test.element, RISE, () => undefined)
    test.runs[0]!.finish()
    await done
    expect(test.element.style.opacity).toBe('1')
    test.motion.dispose()
  })

  it('releases a motion whose engine never reports finishing, once the watchdog elapses', async () => {
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
    expect(test.runs[0]!.complete).toHaveBeenCalledOnce()
    expect(test.runs[0]!.stop).toHaveBeenCalledOnce()
    test.motion.dispose()
  })

  it('releases a running motion the moment the window becomes hidden', async () => {
    const test = harness()
    const done = test.motion.run(test.element, RISE)
    occlude(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await done
    expect(test.runs[0]!.complete).toHaveBeenCalledOnce()
    expect(test.runs[0]!.stop).toHaveBeenCalledOnce()
    test.motion.dispose()
  })

  it('releases a running motion when reduced motion is turned on live', async () => {
    const test = harness()
    const done = test.motion.run(test.element, RISE)
    Object.defineProperty(test.media, 'matches', { configurable: true, value: true })
    test.media.dispatchEvent(new Event('change'))
    await done
    expect(test.runs[0]!.stop).toHaveBeenCalledOnce()
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
    expect(test.runs[0]!.stop).toHaveBeenCalledOnce()
    expect(test.runs[1]!.stop).not.toHaveBeenCalled()
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
    expect(test.runs[1]!.stop).not.toHaveBeenCalled()
    test.motion.release(other)
    await two
    test.motion.dispose()
  })

  it('releases everything on teardown, so an unfinished motion cannot strand its caller', async () => {
    const test = harness()
    const done = test.motion.run(test.element, RISE)
    test.motion.dispose()
    await done
    expect(test.runs[0]!.stop).toHaveBeenCalledOnce()
    // The listeners go with it: a release after teardown would reach into a
    // component that is no longer there.
    occlude(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(test.runs[0]!.stop).toHaveBeenCalledOnce()
  })
})
