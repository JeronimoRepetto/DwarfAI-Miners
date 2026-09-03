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
    /*
     * The strike (issue #74's last piece). The maintainer's own frame map is
     * 1-indexed off the artist's preview GIF and everything else in this file
     * is 0-indexed, so the conversion is stated here rather than left
     * implicit: frame 5 (the swing lands, first spark centered on the pick's
     * tip) becomes index 4.
     *
     * `impactFrames` names that ONE frame alone, restoring the pre-migration
     * `isPickImpact` semantics verbatim (see presentation.ts before #87): a
     * swing bites the rock once, and the old comment beside it warned that
     * marking more "would read as ... a permanent glow around the dwarf
     * rather than as impacts" — exactly what declaring the whole spark span
     * here would do, since each named frame retriggers the debris burst.
     *
     * `glowFrames` is the separate, maintainer-delegated design call: frames
     * 5-6 (index 4-5) are the two brightest the artist drew, and the sprite
     * lights only those beside the art's own sparks. Frames 7-9 (index 6-8)
     * disperse and fade — the art carries that alone.
     */
    working: {
      src: DWARF_SHEET_SRC.worker.working,
      frames: 11,
      frameMs: FRAME_MS,
      impactFrames: [4],
      glowFrames: [4, 5]
    },
    'end-working': { src: DWARF_SHEET_SRC.worker['end-working'], frames: 6, frameMs: FRAME_MS }
  },
  /*
   * The new rank (#157), and the smallest inventory this table admits: an idle
   * and nothing else. Six frames of 36x38, read off the PNG header, and 100ms
   * apiece read off the six Graphic Control Extension blocks of the preview GIF
   * committed beside it — the same cadence every other sheet here was exported
   * at, verified rather than assumed from the pattern.
   *
   * Its WORKING sheet has not been drawn. So a worker2 swinging at a rock plays
   * this idle, by the rule at the top of this file: a rank falls back to its own
   * idle, never to another rank's art. That is why the interim "reuse the
   * worker's sheets" was superseded — a worker2 wearing a worker's skin is the
   * borrowing that rule exists to forbid, and the maintainer's own art landed
   * before it could happen.
   */
  worker2: {
    idle: { src: DWARF_SHEET_SRC.worker2.idle, frames: 6, frameMs: FRAME_MS }
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
