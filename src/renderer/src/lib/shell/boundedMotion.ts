import { animate as motionAnimate } from 'motion-v'
import type { DOMKeyframesDefinition } from 'motion-v'
import { prefersReducedMotion, watchReducedMotion } from '../scene/sceneMotion'
import { motionBoundMs, type MotionTransition } from './motionTiming'

/**
 * What the runner actually calls on the controls motion-v's `animate()` hands
 * back — a small slice of the real `AnimationPlaybackControlsWithThen`, named
 * on its own so a fake engine only has to implement two methods rather than
 * the dozen the full interface carries (`time`, `speed`, `play`, `pause`,
 * `attachTimeline`… none of which the bound has ever needed).
 */
export interface MotionControls {
  /**
   * The ONE teardown method the runner ever calls now, in place of the
   * `complete()`/`stop()` pair an earlier version of this file called in
   * sequence. `complete()` is `animation.finish()`, and on motion-v's WAAPI
   * path the browser writes the run's final frame and discards the effect
   * from inside `onfinish` — a browser EVENT delivered off the document
   * timeline, one Chromium freezes for a window it considers hidden
   * (occluded by another program counts; `backgroundThrottling` is on by
   * default). A run that ends while hidden leaves that event undelivered,
   * and it fires LATE — after this window is visible again — writing
   * whatever `settle` already decided over again. `stop()` made this worse,
   * not better: it returns early once `state === 'finished'`, so calling it
   * after `complete()` did nothing to stop the late write. `cancel()` is the
   * one call that discards the WAAPI effect BEFORE the browser can ever
   * dispatch that event, and it cancels a still-pending keyframe resolver too
   * (confirmed against the real engine, `motionEngine.test.ts`), so a run
   * that never actually started never writes anything either. On the JS
   * driver — any value WAAPI cannot accelerate, `clipPath`'s `calc()` among
   * them — `cancel()` can instead leave the element at an ARBITRARY
   * mid-animation frame (also confirmed against the real engine, not merely
   * read off its source: reading motion-dom's `JSAnimation.cancel()` alone
   * suggests it writes the initial keyframe, but that computed value never
   * gets flushed to `element.style` before `cancel()`'s own teardown stops
   * the driver). Either way, `settle` in `run`, below, always runs right
   * after `cancel()`, never before: whatever this element should show at
   * rest is `settle`'s answer, never `cancel()`'s leftover.
   */
  cancel: () => void
  then: (onResolve: () => void, onReject?: () => void) => Promise<void>
}

/**
 * The engine this runner drives, injected so tests can hand it a hand-written
 * fake instead of the real motion-v (`createBoundedMotion({ animate })`) —
 * the house idiom (`skills/tdd`) over `vi.mock`. Typed on exactly what `run`
 * calls: an element, motion-v's own keyframe shape, and — optionally — a
 * transition.
 *
 * Optional rather than authored (#566, was: always the app's own fixed
 * 250ms/easing pair). The user's ruling was to stop authoring one by
 * default: this runner asks motion-v for NOTHING but the keyframes UNLESS a
 * caller hands one down, so motion-dom's own `getDefaultTransition` decides
 * per value in the ordinary case — see `motionTiming.ts`, which is where
 * this app now reads that same default back to derive its watchdog.
 *
 * A caller gives one when it needs MORE than its own default: the shell's
 * fold (#464) is one motion, not two, so `useShellFold.carry()` passes the
 * clip's own transition to the rail's run rather than let each half of the
 * fold pick a different default and drift apart. `run`'s own fourth
 * argument, below, forwards it here unchanged.
 */
export type MotionAnimate = (
  element: Element,
  keyframes: DOMKeyframesDefinition,
  transition?: MotionTransition
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
 * `cancel()` can still leave a value sitting inline on the element, two
 * different ways depending on which driver ran: on the JS path it may leave
 * an arbitrary mid-animation frame (whatever the driver last rendered before
 * `cancel()`'s own teardown stopped it — see `MotionControls`, above); on the
 * WAAPI path, a run that finished naturally in a VISIBLE window already had
 * its final frame written inline by `onfinish` before `cancel()` ever
 * discarded the (already spent) effect. Either way, a caller with no
 * `settle` of its own owns none of these properties, so they get handed back
 * to the stylesheet rather than left sitting there forever on an element it
 * was supposed to govern again.
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
 * animation finishing, a watchdog one margin past however long THIS run's own
 * keyframes take motion-v's default transition to settle (`motionTiming.ts`
 * — #566, was a fixed 250ms this codebase authored itself), and the window
 * becoming hidden. Reduced motion turned on mid-flight ends it too, because it
 * is a request for the state change without the motion. None of them changes
 * how long a focused window actually animates for (#164); they only bound
 * what may follow it.
 *
 * ## `settle` runs right after `cancel`, never after a late `finish` event
 *
 * Motion-v's WAAPI path commits the run's final frame into `element.style`
 * and discards its own effect from inside `onfinish` — a browser EVENT fired
 * off the document timeline, which Chromium freezes for a window it
 * considers hidden (`backgroundThrottling` is on by default, and a window
 * merely occluded by another program counts). A run that ends while hidden
 * leaves that WAAPI effect finished-but-undelivered: `onfinish` fires LATE,
 * once this window is visible again, and writes the final frame inline
 * whether or not anything is still listening for it. `cancel()` is the one
 * call that discards the effect before that can happen — which is why it
 * runs FIRST below, before this run's own `settle` decides what
 * `element.style` should say, and why nothing here calls `complete()` or
 * `stop()` any more (`complete()`'s `animation.finish()` is exactly the WAAPI
 * method the late `onfinish` fires from; `stop()` returns early once
 * `finish()` already flipped the state, so calling it after did nothing to
 * stop the late write). On the JS driver — any value WAAPI cannot
 * accelerate, `clipPath`'s `calc()` among them — `cancel()` can instead leave
 * the element at an arbitrary mid-animation frame rather than the value
 * either keyframe names (`motionEngine.test.ts` measures this against the
 * real engine; reading motion-dom's own source alone suggests otherwise). So
 * `settle` still has to run right after `cancel()`, not before, either way:
 * the caller's answer for what this element should show has to be the LAST
 * write, never `cancel()`'s leftover. An element whose settled state is not
 * its stylesheet's (a folded clip, a surface held at its hidden keyframe)
 * would snap to the wrong thing for one frame if the caller wrote it too
 * late, which is exactly the repaint the motion exists to hide. The callback
 * is the place to write that state, and it runs right after `cancel` however
 * the run ended — a caller with none of its own gets whatever `cancel` left
 * sitting on the element handed back to the stylesheet instead
 * (`releaseWritten`, below).
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
   *
   * `transition`, when given, is forwarded to the engine unchanged and used
   * to derive the watchdog too (#464) — see `MotionAnimate`, above, for why a
   * caller would ever give one.
   */
  run: (
    element: Element,
    keyframes: DOMKeyframesDefinition,
    settle?: () => void,
    transition?: MotionTransition
  ) => Promise<void>
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
    // environment wants the settled state on the spot, not a derived-duration
    // timer race against nothing actually rendering.
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
    settle?: () => void,
    transition?: MotionTransition
  ): Promise<void> {
    release(element)
    // `transition` undefined: `animate()` gets exactly two arguments, same as
    // ever — motion-v's own `getDefaultTransition` decides per value key
    // (#566 — see `MotionAnimate`, above, and `motionTiming.ts`, which reads
    // that same default back to arm the watchdog below with a matching
    // number). Given, it is passed straight through as a third (#464) —
    // conditionally, rather than always forwarding a possibly-`undefined`
    // third argument, so a fake engine asserting on its own exact call shape
    // (`PanelTransition.test.ts`) sees the same two-argument call it always
    // has for the ordinary case.
    const controls =
      transition === undefined
        ? animate(element, keyframes)
        : animate(element, keyframes, transition)
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
      // `cancel()` FIRST, always: it discards the WAAPI effect (or a still-
      // pending keyframe resolver) before the browser or motion-dom's own JS
      // driver can write anything else, so nothing can land after `settle`
      // below has already decided what this element should show. See
      // `MotionControls`, above, for the full why.
      controls.cancel()
      settle?.()
      // A caller that passed `settle` already owns every property this run
      // touched (that is the whole of the contract above); one that did not
      // gets them handed back to the stylesheet — whatever `cancel()` itself
      // left sitting there, on either driver (`releaseWritten`, above).
      if (settle === undefined) releaseWritten(element, keyframes)
      resolve()
    }
    active.set(element, complete)
    // `then` is the accurate report and stays the first one taken; the
    // watchdog is what makes completion bounded rather than merely likely.
    // Declared after `complete` so it can be the timer's own handle — nothing
    // can reach `clearTimeout` before the timer that is being cleared exists.
    // Armed for THIS run's own keyframes (#566), and the SAME transition just
    // handed to `animate()` above (#464) — a spring's settling time depends
    // on the delta it is asked to travel, so the watchdog has to ask
    // `motionBoundMs` fresh per run rather than share one constant across
    // every shape this runner is ever handed.
    const watchdog = setTimeout(complete, motionBoundMs(keyframes, transition))
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
