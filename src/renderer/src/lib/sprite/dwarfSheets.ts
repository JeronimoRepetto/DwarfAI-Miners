/**
 * Which strips each rank has been drawn, how many frames each holds, and how
 * fast they were meant to be read (issues #74, #87).
 *
 * The frame counts are claims about bytes on disk and nothing at runtime can
 * notice them being wrong — a count one short shears every frame sideways and
 * still renders. `dwarfSheets.test.ts` reads the PNG headers and holds the two
 * together, which is the only check there is.
 *
 * Every frame plays its OWN duration, read from the Aseprite sidecar exported
 * beside its strip (#635; the design's decision log, Frame timing and Sprite
 * frame clock). The v2 sheets played a uniform 100ms read off their preview
 * GIFs; the design replaced that with per-action timing — the pick swing holds
 * its impact frame 200ms and hurries the swing — and `frameMs`, still on every
 * sheet, is now only the `--frame-ms` fallback for a strip with no sidecar.
 * Nothing here restates a duration: the sidecar is the one source, and
 * `dwarfSheets.test.ts` holds its cycles against the art bible's rows.
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
import {
  BASE_SHEET_SIDECAR,
  BASE_SHEET_SRC,
  DWARF_SHEET_SIDECAR,
  DWARF_SHEET_SRC,
  type DwarfSheetName
} from '../art'
import type { DwarfRole } from '../../types'
import type { SpriteSheet } from './spriteSheet'
import { readSidecar, sheetFromSidecar, type SheetExtras } from './spriteSidecar'

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
 * The cues name FRAMES, never seconds. Every strip plays its sidecar's own
 * durations (see the note at the top of this file), so a frame index is the
 * one figure that survives an artist retiming the same movement.
 */
export interface CrewSoundSet {
  readonly strike?: {
    /**
     * A cue on every frame the `working` strip already declares an impact on.
     *
     * A POINTER at that declaration rather than a second copy of frame 4: the
     * strike and the sparks it throws are one event, so the two must not be
     * able to drift apart. There is nothing to tune about WHEN it fires —
     * retiming the hit means moving `impactFrames`, and the sound follows.
     */
    readonly on: 'impactFrames'
    /**
     * How loud the recording opens; absent means its own full level.
     *
     * Optional for the same reason `CrewSoundSignal.gain` is: a rank whose
     * strike needs no taming plays it unscaled, exactly as the worker2's
     * grind always has. See `STRIKE_GAIN` below for why the worker's own
     * needs one.
     */
    readonly gain?: number
  }
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

/**
 * How loud footsteps are: five percent of the ambience channel (#330).
 *
 * One literal for all three ranks, because it is one maintainer decision and
 * not three. Footsteps run under everything else in the mine for as long as
 * somebody is crossing the floor — texture, not an event — and at anything
 * louder a crew walking in reads as the loudest thing in the panel.
 */
const WALK_GAIN = 0.05

/**
 * How loud the pick strike opens: a tenth of the recording (#330 follow-up).
 *
 * The maintainer's first live listen of the crew (PR #339) found the
 * pickaxe recording hot against the room tone — measured by ear, not
 * derived, on 2026-09-09 — the same way WALK_GAIN above was.
 */
const STRIKE_GAIN = 0.1

/**
 * One rank's strip, timed by its sidecar. Throws at load for a strip listed in `DWARF_SHEET_SRC`
 * with no sidecar beside it or a sidecar that is not an export: a sheet quietly falling back to
 * `--frame-ms` would be the uniform tempo the design replaced, and nothing would say so.
 */
function sheet(role: DwarfRole, name: DwarfSheetName, extras?: SheetExtras): SpriteSheet {
  const sources: Partial<Record<DwarfSheetName, string>> = DWARF_SHEET_SRC[role]
  const sidecars: Partial<Record<DwarfSheetName, string>> = DWARF_SHEET_SIDECAR[role]
  const src = sources[name]
  const text = sidecars[name]
  if (src === undefined || text === undefined) {
    throw new Error(`dwarf sheet ${role}/${name} has no strip or no sidecar`)
  }
  return sheetFromSidecar(src, readSidecar(JSON.parse(text)), extras)
}

export const DWARF_SHEETS: Record<DwarfRole, DwarfSheetSet> = {
  worker: {
    idle: sheet('worker', 'idle'),
    'start-working': sheet('worker', 'start-working'),
    /*
     * The strike (issue #74's last piece), on the frame the design names the
     * impact: the one the v3 swing holds 200ms, index 5 (art bible, Working
     * (pick); sound.md, the `strike` cue "on the impact frame"). Until #635 it
     * was index 4, the maintainer's 1-indexed frame 5 read off the v2 preview
     * GIF, where every frame lasted 100ms and no hold marked the hit.
     *
     * `impactFrames` names that ONE frame alone, restoring the pre-migration
     * `isPickImpact` semantics verbatim (see presentation.ts before #87): a
     * swing bites the rock once, and the old comment beside it warned that
     * marking more "would read as ... a permanent glow around the dwarf
     * rather than as impacts" — exactly what declaring the whole spark span
     * here would do, since each named frame retriggers the debris burst.
     *
     * `glowFrames` is the separate, maintainer-delegated design call: index
     * 4-5 are the two brightest frames the artist drew, and the sprite lights
     * only those beside the art's own sparks. The frames after them disperse
     * and fade — the art carries that alone. The v3 export keeps those frames
     * and their order, so the glow stays where it was; the design gives no glow
     * frames of its own, which is an open question on #635.
     */
    working: sheet('worker', 'working', { impactFrames: [5], glowFrames: [4, 5] }),
    'end-working': sheet('worker', 'end-working')
  },
  /*
   * The rank #157 introduced, and it no longer has the smallest inventory this
   * table admits: its working sequence arrived (#211) and is declared below.
   * The idle is six frames of 36x38, read off the PNG header.
   *
   * The working triad is 16/10/17, every count read off its own PNG's IHDR
   * width against the 36px cell — 576/36, 360/36, 612/36, all exact and all 38
   * tall, the same cell as this rank's idle. It is a much longer sequence than
   * the worker's 3/11/6: a slower pick-up, a shorter swing, and a set-down
   * nearly three times the length. That is the art, not a miscount.
   *
   * The v2 preview GIF (dwarf-worker2-working-v2.gif, retired by #635) was
   * the evidence of ORDER, which the worker's own preview could not give: its
   * 73 frames are exactly
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
    idle: sheet('worker2', 'idle'),
    'start-working': sheet('worker2', 'start-working'),
    working: sheet('worker2', 'working'),
    'end-working': sheet('worker2', 'end-working')
  },
  foreman: {
    // The long idle: 28 frames, which is nearly three seconds before it repeats
    // and is why a foreman standing at his post does not read as a loop at all.
    // The design's five-frame short idle is not shipped: nothing plays it.
    idle: sheet('foreman', 'idle'),
    'start-sleep': sheet('foreman', 'start-sleep'),
    sleeping: sheet('foreman', 'sleeping'),
    'end-sleep': sheet('foreman', 'end-sleep')
  }
}

/**
 * Each rank's shift and its own sounds (issues #325, #330).
 *
 * THE ARITHMETIC BELOW IS THE V2 ONE (#635). It was worked at the v2 sheets'
 * uniform 100ms. Under the v3 sidecars the cue at frame 14 opens the grind
 * 300ms before the first swing (frame 15 is held 200ms), a worker2 swing
 * lasts 1.16 s, and eight of them outlast the 8.53 s recording by 1.05 s. The
 * counts and the cue stay the maintainer's until he retunes them by ear; the
 * question is open on #635, and `dwarfSheets.test.ts` pins the v3 figures.
 *
 * BESIDE THE STRIPS RATHER THAN INSIDE THEM. Every value in a `DwarfSheetSet`
 * is a claim about bytes on disk that `dwarfSheets.test.ts` reads the PNG
 * headers to check; these are claims about the READING of that art, and a
 * non-sheet sitting among the sheets would make that check iterate over
 * something it cannot open. Same file, keyed the same way, one table along.
 *
 * ## Where the worker2's numbers come from
 *
 * `worker2-grind.mp3` is 8.53 s of the whole grind — the arms winding up, biting
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
 * cycle at 3 + 26 + 6 = 35 frames, 3.5 s. Its strike is 0.32 s against a
 * 1.3 s swing, so a pick lands and is over well before the next one.
 */
export const DWARF_CREW: Record<DwarfRole, DwarfCrewSet> = {
  worker: {
    swings: 2,
    sound: { strike: { on: 'impactFrames', gain: STRIKE_GAIN }, walk: { gain: WALK_GAIN } }
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

/** Every sheet the app ships, by the design's own key: `worker/working`, `base/idle`. */
export type SpriteSheetKey =
  | `worker/${keyof typeof DWARF_SHEET_SRC.worker}`
  | `worker2/${keyof typeof DWARF_SHEET_SRC.worker2}`
  | `foreman/${keyof typeof DWARF_SHEET_SRC.foreman}`
  | 'base/idle'

/** A sheet by key, and whether it is a transition played once rather than a loop. */
export interface KeyedSheet {
  readonly sheet: SpriteSheet
  readonly once: boolean
}

const TRANSITIONS: ReadonlySet<DwarfSheetName> = new Set([
  'start-working',
  'end-working',
  'start-sleep',
  'end-sleep'
])

/**
 * Every shipped sheet by the design's key (#635): what the sprite atom plays, the design's
 * `DM.SHEETS` (assets.md, Sprite sheets). The ranks' keys point at the ranks' own sheet objects
 * above, never at a copy, so a sheet is timed in one place; the base dwarf's idle is the one sheet
 * no rank plays. A start or end transition plays once, as the design's one-shot sheets do.
 */
export const SPRITE_SHEETS: Record<SpriteSheetKey, KeyedSheet> = (() => {
  const keyed: Partial<Record<SpriteSheetKey, KeyedSheet>> = {}
  for (const role of Object.keys(DWARF_SHEETS) as DwarfRole[]) {
    for (const [name, sheet] of Object.entries(DWARF_SHEETS[role]) as [
      DwarfSheetName,
      SpriteSheet
    ][]) {
      keyed[`${role}/${name}` as SpriteSheetKey] = { sheet, once: TRANSITIONS.has(name) }
    }
  }
  keyed['base/idle'] = {
    sheet: sheetFromSidecar(BASE_SHEET_SRC.idle, readSidecar(JSON.parse(BASE_SHEET_SIDECAR.idle))),
    once: false
  }
  return keyed as Record<SpriteSheetKey, KeyedSheet>
})()
