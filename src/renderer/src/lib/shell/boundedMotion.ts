import { PANEL_MOTION_EASING, PANEL_MOTION_MS, PANEL_MOTION_WATCHDOG_MS } from './panelMotion'

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
 * `fill: 'both'` is what holds the last frame, and cancelling drops it — so an
 * element whose settled state is not its stylesheet's (a folded clip, a surface
 * held at its hidden keyframe) snaps back to where it started for one frame,
 * which is exactly the repaint the motion exists to hide. The callback is the
 * place to write that state, and it runs first however the run ended.
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
  run: (element: Element, keyframes: Keyframe[], settle?: () => void) => Promise<void>
  /** Whether a run is still in flight on this element. */
  running: (element: Element) => boolean
  /** End this element's run now, settling it first. */
  release: (element: Element) => void
  /** End every run now. */
  releaseAll: () => void
  /** Teardown: release everything and stop listening. */
  dispose: () => void
}

export function createBoundedMotion(): BoundedMotion {
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  const active = new Map<Element, () => void>()

  function still(element: Element): boolean {
    return (
      Boolean(media?.matches) ||
      document.hidden ||
      typeof (element as HTMLElement).animate !== 'function'
    )
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

  function run(element: Element, keyframes: Keyframe[], settle?: () => void): Promise<void> {
    release(element)
    const animation = (element as HTMLElement).animate(keyframes, {
      duration: PANEL_MOTION_MS,
      easing: PANEL_MOTION_EASING,
      fill: 'both'
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
      settle?.()
      animation.cancel()
      resolve()
    }
    active.set(element, complete)
    // `finished` is the accurate report and stays the first one taken; the
    // watchdog is what makes completion bounded rather than merely likely.
    // Declared after `complete` so it can be the timer's own handle — nothing
    // can reach `clearTimeout` before the timer that is being cleared exists.
    const watchdog = setTimeout(complete, PANEL_MOTION_WATCHDOG_MS)
    void animation.finished.then(complete, complete)
    return finished
  }

  function releaseHidden(): void {
    if (document.hidden) releaseAll()
  }
  function reduceMotion(): void {
    if (media?.matches) releaseAll()
  }
  media?.addEventListener('change', reduceMotion)
  document.addEventListener('visibilitychange', releaseHidden)

  function dispose(): void {
    media?.removeEventListener('change', reduceMotion)
    document.removeEventListener('visibilitychange', releaseHidden)
    releaseAll()
  }

  return { still, run, running, release, releaseAll, dispose }
}
