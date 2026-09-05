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
     * lights only those beside the art's own sparks. The frames after them
     * disperse and fade — the art carries that alone.
     *
     * Thirteen frames since the loop was redrawn (2026-09-05): the artist
     * lengthened the swing's recovery, and the strike stayed where it was. A
     * per-frame pixel census of the redrawn strip confirmed it — frame 5 is
     * still the one with the most lit pixels, the spark burst — so the indices
     * above did not move; only the count did. Start and end were untouched.
     */
    working: {
      src: DWARF_SHEET_SRC.worker.working,
      frames: 13,
      frameMs: FRAME_MS,
      impactFrames: [4],
      glowFrames: [4, 5]
    },
    'end-working': { src: DWARF_SHEET_SRC.worker['end-working'], frames: 6, frameMs: FRAME_MS }
  },
  /*
   * The rank #157 introduced, and it no longer has the smallest inventory this
   * table admits: its working sequence arrived (#211) and is declared below.
   * The idle is six frames of 36x38, read off the PNG header, at 100ms apiece
   * read off the six Graphic Control Extension blocks of the preview GIF
   * committed beside it.
   *
   * The working triad is 16/10/17, every count read off its own PNG's IHDR
   * width against the 36px cell — 576/36, 360/36, 612/36, all exact and all 38
   * tall, the same cell as this rank's idle. It is a much longer sequence than
   * the worker's 3/11/6: a slower pick-up, a shorter swing, and a set-down
   * nearly three times the length. That is the art, not a miscount.
   *
   * Its 100ms is measured, not inherited from the pattern: every one of
   * dwarf-worker2-working-v2.gif's 73 Graphic Control Extension blocks carries
   * a delay of 10 (hundredths). Those 73 frames are also evidence of ORDER,
   * which the worker's own preview could not give — 73 is exactly
   * 16 + (10 x 4) + 17, the pick-up, four turns of the swing and the set-down
   * concatenated, where the worker's 60 do not decompose into 3/11/6 at all.
   *
   * NO `impactFrames` AND NO `glowFrames` ON ANY OF THE THREE, and that is a
   * SETTLED DECISION rather than art still owed — maintainer ruling on #211.
   * THE WORKER2 CARRIES NO PICK. The worker's two fields exist because its loop
   * lands a strike that bites the rock, throwing debris and lighting sparks;
   * this rank's animation has no strike to name, so there is no frame for
   * either field to point at and no frame map coming. A reader who finds the
   * fields absent here has found the answer, not a hole: do not go looking for
   * numbers, and do not pick a frame by eye. Both fields are optional exactly
   * so a strip with nothing to declare can declare nothing.
   *
   * The interim "reuse the worker's sheets" never landed, and this is why: a
   * worker2 wearing a worker's skin is the borrowing the rule at the top of
   * this file exists to forbid, and the maintainer's own art arrived first.
   */
  worker2: {
    idle: { src: DWARF_SHEET_SRC.worker2.idle, frames: 6, frameMs: FRAME_MS },
    'start-working': {
      src: DWARF_SHEET_SRC.worker2['start-working'],
      frames: 16,
      frameMs: FRAME_MS
    },
    working: { src: DWARF_SHEET_SRC.worker2.working, frames: 10, frameMs: FRAME_MS },
    'end-working': {
      src: DWARF_SHEET_SRC.worker2['end-working'],
      frames: 17,
      frameMs: FRAME_MS
    }
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
