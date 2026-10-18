/**
 * An idle loop the browser plays on its own: a CSS keyframe loop built from a sheet's sidecar
 * durations, so the one thing moving in an idle scene needs no JavaScript timer and no frame clock
 * (NFR-PERF-04; 07 machine 20 `no-sessions`; motion.md, Sprites and idle cost; ISSUE-283).
 *
 * CSS `steps()` alone cannot vary the length of one frame, so every frame gets its own keyframe,
 * placed at the share of the cycle its sidecar duration takes, and each keyframe holds its value
 * (`steps(1, end)`) until the next one. The keyframes move the strip by whole cells with
 * `transform` and nothing else (NFR-PERF-01), so the compositor plays them without layout or paint.
 *
 * The keyframes are shaped for `Element.animate()` and also render as a CSS `@keyframes` rule, so
 * a component may use either; both run off the browser's own animation clock.
 *
 * Under reduced motion an idle loop is a steady first frame and nothing animates (motion.md,
 * Reduced motion: the Veta entrance lantern holds a steady light; NFR-A11Y-10).
 *
 * Pure: it reads the timing it is handed and knows no DOM, no file and no clock.
 */
import type { SheetTiming } from './asepriteSidecar'

/** The easing every keyframe holds its frame with: a whole-frame jump, never a tween. */
export const LOOP_FRAME_EASING = 'steps(1, end)'

/** One keyframe, in the shape `Element.animate()` takes: a strip offset and nothing else. */
export interface LoopKeyframe {
  /** Where in the cycle this frame starts, from 0 to 1. */
  readonly offset: number
  readonly transform: string
  readonly easing: typeof LOOP_FRAME_EASING
}

/** A loop `cssLoop` built: what an idle scene describes its one moving thing with. */
export interface LoopSpec {
  /** The `@keyframes` name; a CSS identifier. */
  readonly name: string
  /** Each frame's hold, in strip order, exactly as the sheet's timing gave it. */
  readonly durationsMs: readonly number[]
  /** `sidecar` or `default`, carried from the sheet's timing. */
  readonly timing: SheetTiming['timing']
  /** One lap: the holds added up; 0 for a steady frame. */
  readonly cycleMs: number
  /** `false` under reduced motion: the loop is its first frame, held. */
  readonly animated: boolean
  /** The frames as keyframes, closed at offset 1 on the last frame; one keyframe when steady. */
  readonly keyframes: readonly LoopKeyframe[]
}

export interface CssLoopInput {
  /** The `@keyframes` name, for example `dm-lantern`. */
  readonly name: string
  /** The sheet's timing, read from its sidecar (`readSheetTiming`). */
  readonly timing: SheetTiming
  /** The width of one cell of the strip, in CSS pixels. */
  readonly cellWidthPx: number
  readonly reducedMotion: boolean
}

const built = new WeakSet<LoopSpec>()

/** Whether `loop` came from `cssLoop`, rather than being a look-alike object. */
export function isCssLoop(loop: unknown): loop is LoopSpec {
  return typeof loop === 'object' && loop !== null && built.has(loop as LoopSpec)
}

const shift = (frame: number, cellWidthPx: number): string =>
  `translateX(${frame === 0 ? 0 : -frame * cellWidthPx}px)`

/** Builds a sheet's idle loop. */
export function cssLoop(input: CssLoopInput): LoopSpec {
  const durationsMs = [...input.timing.durationsMs]
  const cycleMs = durationsMs.reduce((sum, ms) => sum + ms, 0)
  const steady: LoopKeyframe = {
    offset: 0,
    transform: shift(0, input.cellWidthPx),
    easing: LOOP_FRAME_EASING
  }
  const animated = !input.reducedMotion && durationsMs.length > 1 && cycleMs > 0

  const keyframes: LoopKeyframe[] = [steady]
  if (animated) {
    let startMs = 0
    let last = steady
    durationsMs.slice(0, -1).forEach((heldMs, previous) => {
      startMs += heldMs
      last = {
        offset: startMs / cycleMs,
        transform: shift(previous + 1, input.cellWidthPx),
        easing: LOOP_FRAME_EASING
      }
      keyframes.push(last)
    })
    // Closes the cycle on the last frame, so it holds its own duration before the wrap to frame 0.
    keyframes.push({ ...last, offset: 1 })
  }

  const loop: LoopSpec = {
    name: input.name,
    durationsMs,
    timing: input.timing.timing,
    cycleMs: animated ? cycleMs : 0,
    animated,
    keyframes
  }
  built.add(loop)
  return loop
}

/** A loop as CSS: its `@keyframes` rule and the `animation` value that plays it. */
export interface CssLoopRule {
  /** The rule's text; empty for a steady frame. */
  readonly keyframes: string
  /** The `animation` property's value; `none` for a steady frame. */
  readonly animation: string
}

/** Renders a loop as CSS, for a component that styles it rather than calling `Element.animate()`. */
export function cssLoopRule(loop: LoopSpec): CssLoopRule {
  if (!loop.animated) return { keyframes: '', animation: 'none' }
  const stops = loop.keyframes.map(
    ({ offset, transform, easing }) =>
      `${Number((offset * 100).toFixed(4))}% { transform: ${transform}; animation-timing-function: ${easing} }`
  )
  return {
    keyframes: `@keyframes ${loop.name} { ${stops.join(' ')} }`,
    // `linear` across the cycle: each stop's own steps(1, end) does the holding.
    animation: `${loop.name} ${loop.cycleMs}ms linear infinite`
  }
}
