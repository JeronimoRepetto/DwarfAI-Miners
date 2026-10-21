/*
 * The Veta window's bounded motion runner (07 machine 26; ISSUE-292; `DS/docs/motion.md`, Rules: "Never trust
 * animation.finished alone"): plays one transform and opacity motion on an element with the browser's Web Animations,
 * explicit duration, delay and easing from the motion table, and resolves on the first of the motion finishing, its
 * watchdog at its delay + duration + 40 ms, or the window going hidden. An entry fills backwards, so a staggered part
 * stays unseen until its turn; an exit fills forwards and holds its last frame until its element is removed.
 *
 * Framework-agnostic: the window's root composes it and ends it (`dispose`) with its own lifecycle. The timers and the
 * page's visibility are injected (the house idiom over `vi.mock`).
 */
import { VETA_WATCHDOG_MARGIN_MS, type MotionFrames } from './choreography'

export interface VetaMotionTiming {
  readonly duration: number
  readonly delay?: number
  readonly easing: string
  /** `backwards` for an entry, `forwards` for an exit that holds its last frame. */
  readonly fill: FillMode
}

export interface VetaMotionTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface VetaMotionDeps {
  timers?: VetaMotionTimers
  /** The page is hidden: nothing advances, so nothing is waited for. */
  hidden?: () => boolean
  onHidden?: (listener: () => void) => () => void
}

export interface VetaMotion {
  /** Plays `frames` on `element`; resolves when the motion has ended, by any route; never rejects. */
  run(element: Element, frames: MotionFrames, timing: VetaMotionTiming): Promise<void>
  /** Ends every motion on these elements, or every motion, at once: the element shows its own style again. */
  cancel(elements?: readonly Element[]): void
  /** Ends every motion and stops listening. */
  dispose(): void
}

const WINDOW_TIMERS: VetaMotionTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

interface Running {
  readonly element: Element
  readonly animation: Animation
  readonly end: () => void
}

export function createVetaMotion(deps: VetaMotionDeps = {}): VetaMotion {
  const timers = deps.timers ?? WINDOW_TIMERS
  const hidden = deps.hidden ?? (() => typeof document !== 'undefined' && document.hidden)
  const running = new Set<Running>()

  function run(element: Element, frames: MotionFrames, timing: VetaMotionTiming): Promise<void> {
    const animate = (element as HTMLElement).animate
    if (typeof animate !== 'function' || hidden()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const delay = timing.delay ?? 0
      const animation = element.animate([...frames], {
        duration: timing.duration,
        delay,
        easing: timing.easing,
        fill: timing.fill
      })
      let watchdog: unknown = null
      const entry: Running = {
        element,
        animation,
        end() {
          if (!running.has(entry)) return
          running.delete(entry)
          if (watchdog !== null) timers.clear(watchdog)
          // An entry hands the element back to its own style; an exit holds its last frame until it is removed.
          if (timing.fill !== 'forwards') animation.cancel()
          resolve()
        }
      }
      running.add(entry)
      animation.onfinish = () => entry.end()
      watchdog = timers.set(
        () => {
          watchdog = null
          entry.end()
        },
        delay + timing.duration + VETA_WATCHDOG_MARGIN_MS
      )
    })
  }

  function cancel(elements?: readonly Element[]): void {
    for (const entry of [...running]) {
      if (elements !== undefined && !elements.includes(entry.element)) continue
      entry.animation.cancel()
      entry.end()
    }
  }

  const unlisten = deps.onHidden?.(() => {
    if (hidden()) for (const entry of [...running]) entry.end()
  })

  return {
    run,
    cancel,
    dispose() {
      unlisten?.()
      cancel()
    }
  }
}
