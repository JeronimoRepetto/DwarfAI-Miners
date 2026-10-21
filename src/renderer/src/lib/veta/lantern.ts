/*
 * The closed entrance's lantern (07 machine 20 `no-sessions`, `first-run`; ISSUE-287; ISSUE-283's idle budget): the one
 * thing moving while Veta has no sessions, one slow loop of a few frames the browser plays from CSS keyframes, with no
 * JavaScript timer and nothing on the frame clock (NFR-PERF-04; `DS/docs/motion.md`, Sprites and idle cost).
 *
 * The lantern's art is owed (`DS/docs/decisions.md` "Missing art"; art bible, "Closed mine entrance and its lantern
 * loop"), so it is drawn as the design's placeholder: a glow over the lamp whose brightness steps through the
 * `dm-lantern` stops (`DS/docs/motion.md`: 0.55 at 0 %, 0.9 at 30 %, 0.65 at 55 %, 1 at 80 % of 2400 ms). It is laid out
 * the way the drawn art will be, a strip of four cells with a sidecar of their holds, so the swap is a file
 * replacement: the cells are the four stops and the holds their shares of the 2400 ms cycle.
 *
 * Under reduced motion the lantern holds a steady light (`DS/docs/motion.md`, Reduced motion): opacity 0.8, and 0.35
 * on first run (`DS/docs/components.md`, Mine entrance).
 *
 * Pure.
 */
import { readSheetTiming } from '../sprite/asepriteSidecar'
import { cssLoop, type LoopSpec } from '../sprite/cssLoop'

/** One cell of the glow strip: the lamp (4 × 6 px) and its 2 px glow ring on each side. */
export const LANTERN_CELL = { width: 8, height: 10 } as const

/** Each frame's glow, in strip order: the `dm-lantern` stops. */
export const LANTERN_FRAME_OPACITY = [0.55, 0.9, 0.65, 1] as const

/** The steady light under reduced motion: plain, and on first run. */
export const LANTERN_STEADY_OPACITY = { plain: 0.8, first: 0.35 } as const

/** The stand-in sidecar, in the shape Aseprite's scripted export writes: the stops' holds out of 2400 ms. */
const LANTERN_SIDECAR = {
  frames: [720, 600, 600, 480].map((duration, i) => ({
    filename: `lantern ${i}`,
    frame: { x: i * LANTERN_CELL.width, y: 0, w: LANTERN_CELL.width, h: LANTERN_CELL.height },
    duration
  })),
  meta: { frameTags: [{ name: 'lantern', from: 0, to: 3 }] }
}

/** The lantern's loop: `dm-lantern`, one 2400 ms cycle; a steady first frame under reduced motion. */
export function lanternLoop(reducedMotion: boolean): LoopSpec {
  return cssLoop({
    name: 'dm-lantern',
    timing: readSheetTiming(LANTERN_SIDECAR, LANTERN_FRAME_OPACITY.length),
    cellWidthPx: LANTERN_CELL.width,
    reducedMotion
  })
}
