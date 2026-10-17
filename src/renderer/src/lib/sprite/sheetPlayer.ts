/**
 * Which frame of one looping sheet is showing, this far into it (NFR-TIM-10; ISSUE-282).
 *
 * Pure: the elapsed time is handed in, never read, so the frame clock owns time and this owns the
 * answer. It is the one-sheet face of the sequence arithmetic in `spriteSheet.ts`, so a lone sheet
 * and a dwarf's whole sequence can never disagree about a frame edge: each frame holds its own
 * sidecar duration, the loop wraps at the sum of them, and under reduced motion every frame holds a
 * flat 200ms whatever the sidecar says (motion.md, Reduced motion; NFR-A11Y-10).
 */
import type { SheetTiming } from './asepriteSidecar'
import { FALLBACK_FRAME_MS } from './spriteSidecar'
import {
  REDUCED_MOTION_FRAME_MS,
  frameDurationMs,
  loopOf,
  sequenceFrameAt,
  type SpriteSheet
} from './spriteSheet'

function sheetOf(timing: SheetTiming): SpriteSheet {
  return {
    src: '',
    frames: timing.durationsMs.length,
    frameMs: FALLBACK_FRAME_MS,
    durations: timing.durationsMs
  }
}

const flatHold = (reducedMotion: boolean): number | undefined =>
  reducedMotion ? REDUCED_MOTION_FRAME_MS : undefined

/** The frame index showing `elapsedMs` into a looping sheet. */
export function sheetFrameAt(
  timing: SheetTiming,
  elapsedMs: number,
  reducedMotion: boolean
): number {
  return sequenceFrameAt([loopOf(sheetOf(timing))], elapsedMs, flatHold(reducedMotion)).frame
}

/** How long one lap of the sheet takes: its frames' holds added up. */
export function sheetCycleMs(timing: SheetTiming, reducedMotion: boolean): number {
  const sheet = sheetOf(timing)
  let total = 0
  for (let frame = 0; frame < sheet.frames; frame++) {
    total += frameDurationMs(sheet, frame, flatHold(reducedMotion))
  }
  return total
}
