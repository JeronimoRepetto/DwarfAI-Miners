import { animate as motionAnimate, cancelFrame, frame } from 'motion-v'
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
   * The ONE teardown method the runner ever calls now, replacing an earlier
   * `complete()`/`stop()` pair. See the module header below —
   * "`settle` is the runner's last word…" — for why that pair is gone and
   * the full mechanics of what `cancel()` closes, what it does not, and why
   * `settle` still has to run right after it, twice.
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
 * Where `run`'s ender schedules the second, defensive write that closes
 * `settle` being the last one (#566 T2b — see the module header below,
 * "`settle` is the runner's last word…", for why one write is not enough).
 * Injected exactly like `animate`, the same house idiom (`skills/tdd`) over
 * `vi.mock`: production gets motion-v's real `frame.postRender`, and a test
 * hands `createBoundedMotion({ afterRender })` a hand-written recorder
 * instead, so it can decide exactly when that scheduled callback fires
 * rather than racing motion-v's own rAF-driven frameloop — several cases
 * already race `vi.useFakeTimers()` for the watchdog, and a second, real
 * timer here would be a second race no test should have to win.
 */
export type ScheduleAfterRender = (callback: () => void) => void

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
 * Hand a run's animated properties back to the stylesheet — whatever
 * `cancel()` left sitting inline on either driver, which is never clean
 * enough to trust (see the module header below, "`settle` is the runner's
 * last word…"). A caller with no `settle` of its own owns none of these
 * properties, so they get handed back rather than left sitting there
 * forever on an element it was supposed to govern again.
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
 * ## `settle` is the runner's last word, however many times it takes
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
 * stop the late write).
 *
 * `cancel()` closes the same hole a different way on the JS driver: it can
 * leave the element at an arbitrary mid-animation frame rather than the
 * value either keyframe names (`motionEngine.test.ts` measures this against
 * the real engine; reading motion-dom's own source alone suggests
 * otherwise). `x` and `y` — motion-v's own transform shortcuts — are what
 * always run on that driver, never WAAPI's: motion-dom's `acceleratedValues`
 * checks each value by its own name and lists `transform`, but never `x` or
 * `y` themselves, so the shortcuts miss it even though the property they
 * both write does not. `clipPath` (`calc()` included) is NOT a JS-driver
 * case — it is in `acceleratedValues` beside `opacity`, and a real Electron
 * 44 window running motion-dom 13.3.0 shows both on WAAPI (`getAnimations()`
 * lists them).
 *
 * `settle` still has to run right after `cancel()`, not before, either way:
 * an element whose settled state is not its stylesheet's (a folded clip, a
 * surface held at its hidden keyframe) would snap to the wrong thing for one
 * frame if the caller wrote it too late, which is exactly the repaint the
 * motion exists to hide.
 *
 * `cancel()` running first used to be read as the whole fix, and it is not
 * (#566 T2b): it only closes the late WAAPI `onfinish` write above, not a
 * RENDER the engine's own driver already had queued before `cancel()` ran.
 * `JSAnimation.cancel()`'s own `tick(0)` feeds its `onUpdate` straight into
 * `MotionValue.set`, which calls `owner.scheduleRender()`
 * (`render/VisualElement.mjs` ~line 135) — a NativeAnimation mid-flight can
 * leave the same thing queued. That scheduled render is not undone by
 * `cancel()`; it flushes on its own, at the RENDER step of the frame AFTER
 * this one, and writes every one of the visual element's latest values —
 * which is exactly `settle`'s write, overwritten one frame after `settle`
 * made it. A real-window probe of the rail carry caught this directly: a
 * LATE `transform: none` landing a frame after `cancel()` + `settle`, in 3 of
 * 7 experiments.
 *
 * So `complete`, below, writes `settle` (or the hand-back, `releaseWritten`)
 * TWICE: once synchronously right after `cancel()`, so a caller reading the
 * style right after `await run` sees the settled state immediately, and once
 * more scheduled through motion-v's own `frame.postRender` — the step that
 * runs right after `render` in the SAME batch (`frameloop/frame.mjs`'s
 * `stepsOrder`, `frameloop/batcher.mjs`'s `processBatch`), so it lands after
 * the engine's queued render rather than racing it over an uncertain number
 * of frames. `pendingReapply`, below, tracks that second write; `release`,
 * `claim`, `releaseAll` and `dispose` on `BoundedMotion`, below, each say
 * which of them may withdraw it and when.
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
  /**
   * End this element's run now, letting the run's OWN `settle` stand as
   * this element's last word: a re-apply the ending schedules (T2b) is left
   * standing, because nobody else is about to write the element afterward.
   *
   * This is `useShellFold`'s rail carry and `PanelTransition`'s own finish —
   * both end a run through this and never touch the element themselves
   * again, so the run's late-render protection has to survive them. A
   * re-apply already pending BEFORE this call, left by an EARLIER run that
   * had already ended, is withdrawn regardless: an old run's answer must
   * never land on top of whichever run owns the element next.
   *
   * A caller that is about to write the element's OWN state right after —
   * `MessagePanelWindow`'s `armRise` and its cut branch — wants the
   * opposite guarantee and calls `claim`, below, instead.
   */
  release: (element: Element) => void
  /**
   * End this element's run now AND withdraw every re-apply pending for it —
   * including one ending an ACTIVE run would otherwise have scheduled (T2b)
   * — because THIS caller is about to write the element's state itself, and
   * nothing the runner still owes it may land afterward.
   *
   * This is `MessagePanelWindow`'s `armRise` and the cut branch of its
   * `panel` watch, both of which call this and then write `holdHidden` /
   * `releaseHidden` right after — the exact case `release`, above, is not
   * safe for, because THAT method would leave whatever it just ended free to
   * fire its own re-apply over what this caller wrote. The cut branch meets
   * this ACTIVE: a reopen or a dwarf switch landing while the leave it cuts
   * off is still in flight ends that live run. `armRise` meets it settled:
   * by construction it only runs once a leave has fully finished, so what it
   * withdraws is that leave's own re-apply, left pending because main had
   * already hidden the window before the scheduled frame ran — #566's own
   * bug. `claim` is correct either way, which is the point of using it in
   * both places rather than reasoning about which case a given call is.
   * `run`, below, claims the element for the same reason before starting its
   * own keyframes.
   */
  claim: (element: Element) => void
  /**
   * End every run now. Pending re-applies are left standing on purpose
   * (#566 hotfix): this runs on `visibilitychange` -> hidden and on reduced
   * motion turning on, and the re-apply IS the protection that lands
   * `settle` after the engine's own deferred render once frames resume
   * (T2b) — withdrawing it here would reopen the exact late-render race T2b
   * closed. Only a STALE one already pending before `release(element)` is
   * called, `claim(element)`, a newer `run(element)`, or `dispose()`
   * withdraw one.
   */
  releaseAll: () => void
  /** Teardown: release everything and stop listening. */
  dispose: () => void
}

export function createBoundedMotion(
  deps: { animate?: MotionAnimate; afterRender?: ScheduleAfterRender } = {}
): BoundedMotion {
  const animate = deps.animate ?? motionAnimate
  const afterRender = deps.afterRender ?? ((callback) => frame.postRender(callback))
  const active = new Map<Element, () => void>()
  /**
   * The re-apply `complete` scheduled for this element, if one is still
   * outstanding (#566 T2b). Keyed separately from `active`: by the time this
   * is set, `complete` has already deleted the element from `active` — a
   * pending re-apply is not a run in flight, it is a write still owed to an
   * element whose run already ended.
   *
   * Who withdraws a pending entry, and when, is `release`, `claim`,
   * `releaseAll` and `dispose`'s own contract — see each on `BoundedMotion`,
   * above.
   */
  const pendingReapply = new Map<Element, () => void>()
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
    // Read BEFORE ending the active run below: ending it can schedule a
    // FRESH re-apply (T2b), and reading after would mistake that new one for
    // a stale leftover. See `release`'s own doc on `BoundedMotion` for which
    // of the two this withdraws.
    const hadStaleReapply = pendingReapply.has(element)
    active.get(element)?.()
    if (hadStaleReapply) cancelPendingReapply(element)
  }

  function claim(element: Element): void {
    // `release`'s own effect, then an unconditional withdrawal on top — see
    // `claim`'s doc on `BoundedMotion` for why nothing may survive it.
    release(element)
    cancelPendingReapply(element)
  }

  function releaseAll(): void {
    // A copy, because completing one run deletes it from the map underneath.
    // Pending re-applies are deliberately left standing: see `releaseAll`'s
    // doc on `BoundedMotion`, above, for why.
    for (const complete of [...active.values()]) complete()
  }

  /**
   * Withdraw the re-apply `complete` scheduled for `element`, if one is
   * still outstanding — cancelling motion-v's own scheduled frame callback
   * so nothing this instance still owes the element lands late. Called
   * unconditionally by `claim` and `dispose`, conditionally by `release`,
   * never by `releaseAll`; see each on `BoundedMotion` for which and why.
   */
  function cancelPendingReapply(element: Element): void {
    const reapply = pendingReapply.get(element)
    if (reapply === undefined) return
    pendingReapply.delete(element)
    cancelFrame(reapply)
  }

  function run(
    element: Element,
    keyframes: DOMKeyframesDefinition,
    settle?: () => void,
    transition?: MotionTransition
  ): Promise<void> {
    // A new run owns `element` outright — see `claim`'s own doc on
    // `BoundedMotion` for why nothing the runner still owes may survive it.
    claim(element)
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
      // `cancel()` FIRST, always: it closes the late-write hole (see
      // `MotionControls`, above) before `settle` below decides what this
      // element should show.
      controls.cancel()
      settle?.()
      // A caller that passed `settle` already owns every property this run
      // touched (that is the whole of the contract above); one that did not
      // gets them handed back to the stylesheet — whatever `cancel()` itself
      // left sitting there, on either driver (`releaseWritten`, above).
      if (settle === undefined) releaseWritten(element, keyframes)
      resolve()
      // The scheduled second write closing #566 T2b — see the module
      // header, "`settle` is the runner's last word…", for why one write is
      // not enough. Guarded by identity against the element's NEXT run
      // rather than this one — `reapply` has already resolved everything
      // this run owes, so nothing here needs `active`'s guard a second time.
      const reapply = (): void => {
        if (pendingReapply.get(element) !== reapply) return
        pendingReapply.delete(element)
        settle?.()
        if (settle === undefined) releaseWritten(element, keyframes)
      }
      pendingReapply.set(element, reapply)
      afterRender(reapply)
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
    // `releaseAll` above can itself have just scheduled fresh re-applies (any
    // run still active at teardown ends through the same `complete`); sweep
    // whatever is left so nothing this instance owns writes to the DOM after
    // its caller has stopped believing it is there.
    for (const element of [...pendingReapply.keys()]) cancelPendingReapply(element)
  }

  return { still, run, running, release, claim, releaseAll, dispose }
}
