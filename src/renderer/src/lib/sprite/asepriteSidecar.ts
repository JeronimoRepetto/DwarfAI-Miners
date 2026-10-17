/**
 * A sheet's timing as the frame clock plays it: each frame's hold from the sheet's Aseprite JSON
 * sidecar, or the `--frame-ms` fallback where there is none (NFR-TIM-10; ISSUE-282).
 *
 * The lenient reading of a sidecar. `readSidecar` (spriteSidecar.ts) refuses a malformed sidecar
 * loudly, which is what the bundled crew sheets want at load; this one never throws and never logs
 * (`lib/**` is pure presentation): a sidecar that is missing or not an export plays at 100ms a
 * frame and says so through `timing: 'default'`, so a caller or a test can tell a sheet that lost
 * its sidecar from one that was timed by it.
 */
import { FALLBACK_FRAME_MS, readSidecar } from './spriteSidecar'

export interface SheetTiming {
  /** Each frame's hold in milliseconds, in strip order. */
  readonly durationsMs: readonly number[]
  /** `sidecar` where the durations came from the sidecar, `default` for the 100ms fallback. */
  readonly timing: 'sidecar' | 'default'
}

/** A strip of `frames` frames with no usable sidecar: every frame held for `--frame-ms`. */
export function defaultSheetTiming(frames: number): SheetTiming {
  const count = Math.max(0, Math.floor(frames))
  return { durationsMs: Array.from({ length: count }, () => FALLBACK_FRAME_MS), timing: 'default' }
}

/**
 * Reads a parsed sidecar (`undefined` where the sheet has none). `frames` is the strip's own frame
 * count, used only where the sidecar cannot be: a missing or malformed sidecar is the 100ms default.
 */
export function readSheetTiming(json: unknown, frames: number): SheetTiming {
  if (json === undefined) return defaultSheetTiming(frames)
  try {
    return { durationsMs: readSidecar(json).durations, timing: 'sidecar' }
  } catch {
    return defaultSheetTiming(frames)
  }
}
