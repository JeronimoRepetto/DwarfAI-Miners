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
 * THE ORDER THE WORKING TRIAD IS PLAYED IN is not this file's to decide and is
 * stated here only because the counts above are read as evidence of it: since
 * #325 a dwarf at the rock plays `start-working`, its swing however many times
 * `DWARF_CREW` below says, then `end-working`, and then begins again — a shift
 * cycle rather than a swing that never stops — and plays `end-working` alone,
 * once, on the way out. `dwarfSequence.ts` owns that. The previews' own repeat
 * counts (the worker's several turns, the worker2's four) are the artist
 * showing a movement REPEATING, and are evidence of which strips belong to one
 * animation and in what order — never of how many turns the panel takes before
 * setting the pick down, which is a reading decision: #325 made it, and #330
 * moved it into `DWARF_CREW` where a sound could be held against it.
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

/**
 * What a rank sounds like, cue by cue (issue #330).
 *
 * DATA RATHER THAN A BRANCH ON THE RANK, which is the whole point: a worker
 * strikes and a worker2 grinds because their sheets say so, and the foreman is
 * silent at the rock because his say nothing. Nothing that plays a sound is
 * allowed to know which rank it is holding.
 *
 * The cues name FRAMES, never seconds. Every strip here is held at 100ms
 * (see the note at the top of this file), so a frame index is the one figure
 * that survives an artist re-exporting the same movement at another tempo.
 */
export interface CrewSoundSet {
  /**
   * A cue on every frame the `working` strip already declares an impact on.
   *
   * A POINTER at that declaration rather than a second copy of frame 4: the
   * strike and the sparks it throws are one event, so the two must not be
   * able to drift apart. There is nothing to tune here — retiming the hit
   * means moving `impactFrames`, and the sound follows.
   */
  readonly strike?: { readonly on: 'impactFrames' }
  /**
   * One cue per shift, opened as the named strip reaches the named frame.
   *
   * The worker2's grind is a single recording of the WHOLE movement — arms
   * winding up, biting the rock, and stopping — so it is timed against the
   * cycle rather than triggered by a hit inside it. See `DWARF_CREW` below
   * for the arithmetic that fixes both numbers.
   */
  readonly shift?: { readonly sheet: DwarfSheetName; readonly frame: number }
  /**
   * A cue for as long as the dwarf is walking, at its own quiet gain.
   *
   * THE ONE CUE THAT IS NOT A FRAME. The other two are read off the strip
   * showing; a walk is the sprite being moved ACROSS the interior, which is a
   * position rather than an animation — so it is declared by every rank that
   * walks, which is all of them, and it is the one crew sound a viewer who
   * asked for less movement still hears.
   */
  readonly walk?: { readonly gain: number }
}

/** A rank's shift: how long it is, and what it sounds like. */
export interface DwarfCrewSet {
  /**
   * How many times the shift swings before the pick goes down (#325, #330).
   *
   * Per rank rather than the literal "twice" #325 shipped, because the count
   * is what holds a sound against the art: see `DWARF_CREW`. Absent for a rank
   * with no swing drawn, which is the foreman.
   */
  readonly swings?: number
  /** What this rank sounds like, or nothing where it makes no sound. */
  readonly sound?: CrewSoundSet
}

/** The tempo every sheet was exported at; see the note above. */
const FRAME_MS = 100

/**
 * How loud footsteps are: five percent of the ambience channel (#330).
 *
 * One literal for all three ranks, because it is one maintainer decision and
 * not three. Footsteps run under everything else in the mine for as long as
 * somebody is crossing the floor — texture, not an event — and at anything
 * louder a crew walking in reads as the loudest thing in the panel.
 */
const WALK_GAIN = 0.05

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
   * FOUR turns is the preview's own count and not the panel's: the shift cycle
   * takes two before it sets the pick down and starts over (#325, and see the
   * note on order at the top of this file).
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

/**
 * Each rank's shift and its own sounds (issues #325, #330).
 *
 * BESIDE THE STRIPS RATHER THAN INSIDE THEM. Every value in a `DwarfSheetSet`
 * is a claim about bytes on disk that `dwarfSheets.test.ts` reads the PNG
 * headers to check; these are claims about the READING of that art, and a
 * non-sheet sitting among the sheets would make that check iterate over
 * something it cannot open. Same file, keyed the same way, one table along.
 *
 * ## Where the worker2's numbers come from
 *
 * `hands-sfx.mp3` is 8.53 s of the whole grind — the arms winding up, biting
 * the rock and stopping — so the shift has to be as long as the recording
 * rather than the recording as long as the shift. The maintainer's own ruling
 * fixes both ends: it starts "just before the working begins", 200 ms out,
 * and must die away as the arms do, about three frames into the set-down.
 * With 16 frames of pick-up at 100 ms that puts the cue at frame 14, and
 *
 *     0.2 s + 8 x 1.0 s + 0.3 s = 8.5 s
 *
 * leaves eight swings as the only count that fits between the two. The cycle
 * is then 16 + 80 + 17 = 113 frames, 11.3 s a shift. THE NUMBERS ARE THE
 * MAINTAINER'S AND ARE JUDGED BY EAR: do not retune either by eye.
 *
 * The worker's stays at two, which is what #325 read as a shift, and its
 * cycle at 3 + 26 + 6 = 35 frames, 3.5 s. Its strike is 0.57 s against a
 * 1.3 s swing, so a pick lands and is over well before the next one.
 */
export const DWARF_CREW: Record<DwarfRole, DwarfCrewSet> = {
  worker: {
    swings: 2,
    sound: { strike: { on: 'impactFrames' }, walk: { gain: WALK_GAIN } }
  },
  worker2: {
    swings: 8,
    // No strike, and there is no frame for one to point at: the worker2
    // carries no pick and its strips declare no impact (see the note on this
    // rank above, and #211). Its whole shift is the sound instead of the hit.
    sound: { shift: { sheet: 'start-working', frame: 14 }, walk: { gain: WALK_GAIN } }
  },
  foreman: {
    // No swing count, because no swing is drawn — `dwarfSequence` never builds
    // a cycle for him at all — and no sound at the rock for the same reason:
    // his `working` is a session producing tokens, not a pick on a rock. He
    // walks like everybody else, so the footsteps are the one cue he has.
    sound: { walk: { gain: WALK_GAIN } }
  }
}
