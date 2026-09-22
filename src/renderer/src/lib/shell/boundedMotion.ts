import { animate as motionAnimate } from 'motion-v'
import type { DOMKeyframesDefinition, Easing } from 'motion-v'
import { prefersReducedMotion, watchReducedMotion } from '../scene/sceneMotion'
import { PANEL_MOTION_EASE, PANEL_MOTION_MS, PANEL_MOTION_WATCHDOG_MS } from './panelMotion'

/**
 * What the runner actually calls on the controls motion-v's `animate()` hands
 * back — a small slice of the real `AnimationPlaybackControlsWithThen`, named
 * on its own so a fake engine only has to implement three methods rather than
 * the dozen the full interface carries (`time`, `speed`, `play`, `pause`,
 * `attachTimeline`… none of which the bound has ever needed).
 */
export interface MotionControls {
  /** Best-effort: jump to the final frame and settle the thenable. */
  complete: () => void
  /**
   * Halt wherever the run currently is, without settling the thenable — the
   * ONLY teardown method the bound ever calls, in place of WAAPI's
   * `cancel()`. `cancel()` composited on a WAAPI effect layer `element.style`
   * never held; motion-v writes straight into `element.style`, so there is no
   * separate layer for a `cancel`-shaped method to drop, and `stop()` is
   * motion-v's own name for "halt in place" once `settle` has already decided
   * what `element.style` should say.
   */
  stop: () => void
  then: (onResolve: () => void, onReject?: () => void) => Promise<void>
}

/**
 * The engine this runner drives, injected so tests can hand it a hand-written
 * fake instead of the real motion-v (`createBoundedMotion({ animate })`) —
 * the house idiom (`skills/tdd`) over `vi.mock`. Typed on exactly what `run`
 * calls: an element, motion-v's own keyframe shape, and the one transition it
 * ever asks for.
 */
export type MotionAnimate = (
  element: Element,
  keyframes: DOMKeyframesDefinition,
  options: { duration: number; ease: Easing }
) => MotionControls

/**
 * Which CSS property each motion-v keyframe key this app ever passes writes
 * onto the element: `x` and `y` are transform SHORTCUTS, and both land on the
 * one `transform` property rather than a property of their own.
 */
const STYLE_PROPERTY: Partial<Record<string, string>> = {
  opacity: 'opacity',
  x: 'transform',
  y: 'transform',
  clipPath: 'clip-path'
}

/**
 * Hand a run's animated properties back to the stylesheet.
 *
 * WAAPI's `fill: 'both'` composited on TOP of `element.style` and cost
 * nothing to drop with `cancel()` — the element's own inline style, which
 * `settle` alone ever wrote, was always what showed through underneath.
 * Motion-v writes its final frame straight into `element.style` instead, so a
 * caller with no `settle` of its own would otherwise be left holding whatever
 * the engine wrote, forever, on an element the stylesheet was supposed to
 * govern again.
 */
function releaseWritten(element: Element, keyframes: DOMKeyframesDefinition): void {
  const style = (element as HTMLElement).style
  if (style === undefined) return
  const properties = new Set(
    Object.keys(keyframes)
      .map((key) => STYLE_PROPERTY[key])
      .filter((property): property is string => property !== undefined)
  )
  for (const property of properties) style.removeProperty(property)
}

/**
 * One run of the app's panel motion, bounded the way #266 requires.
 *
 * ## Why this is one module and not one per surface
 *
 * `PanelTransition` (a column leaving the shell) and `useShellFold` (the amber
 * ground folding into the rail) had written the same runner twice, down to the
 * watchdog and the two listeners, and the message panel's own window (#389)
 * would have been the third copy. What they share is not a shape but a RULE,
 * and it is the rule that keeps being got wrong:
 *
 * **`animation.finished` is not a promise of completion.** Web Animations run
 * on the document timeline, and Chromium freezes it for a window it considers
 * hidden — which on Windows includes one another program has occluded, since
 * `backgroundThrottling` is on by default. The compositor still lands the last
 * frame, so the element reaches its final keyframe while the main thread never
 * resolves `finished`, and whoever was waiting on it waits forever. That is the
 * entirely-yellow frame #266 photographed.
 *
 * So every run here reports itself three ways and the first one wins: the
 * animation finishing, a watchdog one margin past the 250ms, and the window
 * becoming hidden. Reduced motion turned on mid-flight ends it too, because it
 * is a request for the state change without the motion. None of them changes
 * the 250ms a focused window animates for (#164); they only bound what may
 * follow it.
 *
 * ## `settle` runs before the animation is let go
 *
 * The engine holds the last frame until the run is let go — under WAAPI that
 * was `fill: 'both'`, composited on top of `element.style` and dropped for
 * free by `cancel()`; motion-v (#566) writes the last frame straight into
 * `element.style` instead, so `stop()` leaves it exactly where it was rather
 * than handing it back. Either way, an element whose settled state is not its
 * stylesheet's (a folded clip, a surface held at its hidden keyframe) would
 * snap to the wrong thing for one frame if the caller wrote it too late, which
 * is exactly the repaint the motion exists to hide. The callback is the place
 * to write that state, and it runs first however the run ended — a caller
 * with none of its own gets whatever motion-v wrote handed back to the
 * stylesheet instead (`releaseWritten`, below).
 *
 * ## Framework-agnostic on purpose
 *
 * It owns listeners and timers but no component lifecycle: `dispose()` is the
 * whole of the teardown, and the two callers wire it to their own
 * `onBeforeUnmount`. That is what keeps it in `lib/` beside the constants and
 * keyframes it runs, testable without mounting anything.
 */
export interface BoundedMotion {
  /**
   * Whether there is no motion to run at all: reduced motion asked for the
   * state change outright, the window is hidden and cannot advance the
   * timeline, or the element has no Web Animations to run (a test environment,
   * and jsdom is one). All three take the caller's instant path — and it has to
   * be the CALLER's, because what "instant" means is the settled state, which
   * only the caller knows.
   */
  still: (element: Element) => boolean
  /**
   * Start the panel's one timing on this element, ending whatever this runner
   * was already running on it. Resolves when the motion is over by any of the
   * three routes above — never rejects, because a torn-down motion is not
   * evidence that whatever was waiting on it should keep waiting.
   */
  run: (element: Element, keyframes: DOMKeyframesDefinition, settle?: () => void) => Promise<void>
  /** Whether a run is still in flight on this element. */
  running: (element: Element) => boolean
  /** End this element's run now, settling it first. */
  release: (element: Element) => void
  /** End every run now. */
  releaseAll: () => void
  /** Teardown: release everything and stop listening. */
  dispose: () => void
}

export function createBoundedMotion(deps: { animate?: MotionAnimate } = {}): BoundedMotion {
  const animate = deps.animate ?? motionAnimate
  const active = new Map<Element, () => void>()
  /**
   * The viewer's answer as it stands, from `sceneMotion` rather than a
   * `matchMedia` of this module's own: the app asks that one query in one
   * place (#71), and a platform that can report the preference without
   * watching it change keeps the answer it gave here instead of failing.
   */
  let reduced = prefersReducedMotion()

  function still(element: Element): boolean {
    // Not "can this element run Web Animations" any more — motion-v needs no
    // such method, and would still drive values through its own rAF timers in
    // jsdom (`motionEngine.test.ts`). What `Element.animate` being missing
    // still tells us is that this is not a real Chromium window: a test
    // environment wants the settled state on the spot, not a 250ms timer race
    // against nothing actually rendering.
    return reduced || document.hidden || typeof (element as HTMLElement).animate !== 'function'
  }

  function running(element: Element): boolean {
    return active.has(element)
  }

  function release(element: Element): void {
    active.get(element)?.()
  }

  function releaseAll(): void {
    // A copy, because completing one run deletes it from the map underneath.
    for (const complete of [...active.values()]) complete()
  }

  function run(
    element: Element,
    keyframes: DOMKeyframesDefinition,
    settle?: () => void
  ): Promise<void> {
    release(element)
    const controls = animate(element, keyframes, {
      duration: PANEL_MOTION_MS / 1000,
      ease: PANEL_MOTION_EASE
    })
    let resolve!: () => void
    const finished = new Promise<void>((done) => {
      resolve = done
    })
    const complete = (): void => {
      // Identity rather than presence: a later run on the same element has
      // already replaced this entry, and an old animation reporting itself
      // afterwards must not end the one that took its place.
      if (active.get(element) !== complete) return
      active.delete(element)
      clearTimeout(watchdog)
      // Best-effort: the T0 probe found `complete()` can land the value LATE
      // rather than never even once the window is hidden, and does nothing
      // harmful when the engine already finished on its own — `settle` below
      // is what actually guarantees the state either way, so this never needs
      // a try/catch around it.
      controls.complete()
      settle?.()
      // A caller that passed `settle` already owns every property this run
      // touches (that is the whole of the contract above); one that did not
      // gets them handed back to the stylesheet, the way `cancel()` used to
      // for free.
      if (settle === undefined) releaseWritten(element, keyframes)
      controls.stop()
      resolve()
    }
    active.set(element, complete)
    // `then` is the accurate report and stays the first one taken; the
    // watchdog is what makes completion bounded rather than merely likely.
    // Declared after `complete` so it can be the timer's own handle — nothing
    // can reach `clearTimeout` before the timer that is being cleared exists.
    const watchdog = setTimeout(complete, PANEL_MOTION_WATCHDOG_MS)
    void controls.then(complete, complete)
    return finished
  }

  function releaseHidden(): void {
    if (document.hidden) releaseAll()
  }
  const unwatchReduced = watchReducedMotion((asked) => {
    reduced = asked
    if (reduced) releaseAll()
  })
  document.addEventListener('visibilitychange', releaseHidden)

  function dispose(): void {
    unwatchReduced()
    document.removeEventListener('visibilitychange', releaseHidden)
    releaseAll()
  }

  return { still, run, running, release, releaseAll, dispose }
}
