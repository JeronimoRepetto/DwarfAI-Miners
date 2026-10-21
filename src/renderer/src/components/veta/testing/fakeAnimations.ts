/*
 * A hand-written Web Animations stand-in for the Veta choreography tests (ISSUE-292; 17 §2.2): jsdom has no
 * `Element.animate`, so each run is recorded with its element, keyframes and timing, and ends only when the test says
 * so. The entrance lantern's endless loop is recorded too, apart from the motions. Never imported by production code
 * (R14).
 */
export interface FakeRun {
  readonly element: Element
  readonly keyframes: readonly Keyframe[]
  readonly options: KeyframeAnimationOptions
  ended: boolean
  cancelled: boolean
  onfinish: (() => void) | null
  cancel(): void
  finish(): void
}

export interface FakeAnimations {
  readonly runs: readonly FakeRun[]
  /** The motions in flight: not ended, not cancelled, not an endless loop. */
  live(): FakeRun[]
  /** Ends every motion in flight. */
  finishAll(): void
  restore(): void
}

export function fakeAnimations(): FakeAnimations {
  const runs: FakeRun[] = []
  function animate(
    this: Element,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions
  ): FakeRun {
    const run: FakeRun = {
      element: this,
      keyframes,
      options: options ?? {},
      ended: false,
      cancelled: false,
      onfinish: null,
      cancel() {
        run.cancelled = true
      },
      finish() {
        if (run.ended || run.cancelled) return
        run.ended = true
        run.onfinish?.()
      }
    }
    runs.push(run)
    return run
  }
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: animate
  })
  const live = (): FakeRun[] =>
    runs.filter((r) => !r.ended && !r.cancelled && r.options.iterations !== Infinity)
  return {
    runs,
    live,
    finishAll() {
      for (const run of live()) run.finish()
    },
    restore() {
      delete (HTMLElement.prototype as { animate?: unknown }).animate
    }
  }
}
