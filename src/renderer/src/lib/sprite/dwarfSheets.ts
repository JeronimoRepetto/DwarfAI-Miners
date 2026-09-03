/**
 * Which strips each rank has been drawn, how many frames each holds, and how
 * fast they were meant to be read (issues #74, #87).
 *
 * The frame counts are claims about bytes on disk and nothing at runtime can
 * notice them being wrong — a count one short shears every frame sideways and
 * still renders. `dwarfSheets.test.ts` reads the PNG headers and holds the two
 * together, which is the only check there is.
 *
 * `frameMs` is 100 throughout because that is the delay in every preview GIF
 * the maintainer exported beside the sheets, transitions included. It is the
 * artist's cadence read off the artist's file, not a tempo chosen here — the
 * working preview (dwarf-worker-working-v2.gif) confirms the same 100ms, read
 * off its own Graphic Control Extension blocks, though its 60 encoded frames
 * loop the swing several times rather than concatenating start+loop+end once
 * each, unlike the foreman's sleep preview.
 *
 * ONE SHEET PER RANK IS REQUIRED and it is `idle`. Everything else is optional,
 * and a state a rank has no drawing for falls back to that idle rather than to
 * another rank's art — which is why a worker currently idles through waiting
 * and walking, having only working (#74's next delivery) and idle drawn.
 */
import { DWARF_SHEET_SRC, type DwarfSheetName } from '../art'
import type { DwarfRole } from '../../types'
import type { SpriteSheet } from './spriteSheet'

export type { DwarfSheetName }

/** A rank's strips. `idle` is guaranteed; the rest are as drawn. */
export type DwarfSheetSet = { idle: SpriteSheet } & Partial<Record<DwarfSheetName, SpriteSheet>>

/** The tempo every sheet was exported at; see the note above. */
const FRAME_MS = 100

export const DWARF_SHEETS: Record<DwarfRole, DwarfSheetSet> = {
  worker: {
    idle: { src: DWARF_SHEET_SRC.worker.idle, frames: 6, frameMs: FRAME_MS },
    'start-working': {
      src: DWARF_SHEET_SRC.worker['start-working'],
      frames: 3,
      frameMs: FRAME_MS
    },
    working: { src: DWARF_SHEET_SRC.worker.working, frames: 11, frameMs: FRAME_MS },
    'end-working': { src: DWARF_SHEET_SRC.worker['end-working'], frames: 6, frameMs: FRAME_MS }
  },
  foreman: {
    // The long idle: 28 frames, which is nearly three seconds before it repeats
    // and is why a foreman standing at his post does not read as a loop at all.
    // A six-frame short idle is also committed and is not played by anything.
    idle: { src: DWARF_SHEET_SRC.foreman.idle, frames: 28, frameMs: FRAME_MS },
    'start-sleep': { src: DWARF_SHEET_SRC.foreman['start-sleep'], frames: 8, frameMs: FRAME_MS },
    sleeping: { src: DWARF_SHEET_SRC.foreman.sleeping, frames: 12, frameMs: FRAME_MS },
    'end-sleep': { src: DWARF_SHEET_SRC.foreman['end-sleep'], frames: 11, frameMs: FRAME_MS }
  }
}
