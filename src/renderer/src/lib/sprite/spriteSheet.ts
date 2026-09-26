/**
 * One animation packed as a horizontal strip of frames in a single PNG, and the
 * arithmetic for showing exactly one of them (issue #87).
 *
 * Everything here is pure and knows about no asset, no DOM and no clock: the
 * component owns the interval, this owns the answer to "which frame now". That
 * split is what lets the cadence be tested without a fake timer, and it is why
 * `sequenceFrameAt` takes an elapsed figure rather than reading one.
 *
 * A SEQUENCE is a list of clips played in order, and it is how a transition
 * that plays once hands over to what waits behind it — falling asleep into
 * sleeping, waking into idle. Where it SETTLES is its first `loop` clip and
 * everything behind that is unreachable; a sequence of nothing but `once` clips
 * settles on the last one's final frame rather than replaying a gesture as
 * though it were an idle.
 *
 * What it settles into is a CYCLE rather than a single strip (issue #325): a run
 * of consecutive `loop` clips repeats as one movement, which is what lets a
 * dwarf's shift be a pick-up, its swings and a set-down played round and round
 * instead of a swing that never stops. One `loop` clip is a cycle of one.
 */

/**
 * The pixel box every hand-drawn dwarf frame is authored in.
 *
 * Measured off the committed sheets' own PNG headers, which is the only source
 * that cannot be stale — the design document states 34x36 and the drawings
 * arrived at 36x38 (see dwarfSheets.test.ts, which holds the two together).
 *
 * It is a ratio as much as a size: `sceneSizing` derives the sprite's drawn box
 * from it, and the panel scales a 38px-tall drawing to around 100px, so the
 * scale factor is never an integer. That is what makes `image-rendering:
 * pixelated` load-bearing rather than cosmetic (issue #90).
 */
export const SPRITE_FRAME_SIZE = { width: 36, height: 38 } as const

/** A strip of frames in one file, and how fast it is meant to be read. */
export interface SpriteSheet {
  readonly src: string
  /** How many frames the strip holds, left to right. */
  readonly frames: number
  /**
   * How long each frame is held where the sheet has no `durations`: `--frame-ms`, the fallback
   * for a sheet with no Aseprite JSON sidecar (motion.md, Sprite frame timing).
   */
  readonly frameMs: number
  /**
   * Each frame's own hold, in strip order, read from the sheet's sidecar (#635). Present, it is
   * the sheet's timing and `frameMs` is not read; see `spriteSidecar.ts`.
   */
  readonly durations?: readonly number[]
  /**
   * The frames on which the tool bites the rock. Sparks fire on these and
   * nowhere else, so a sheet that names none throws none — which is the honest
   * answer while the only sheets drawn are idles (issue #74).
   */
  readonly impactFrames?: readonly number[]
  /**
   * The frames bright enough to earn the sprite's own strike glow, layered
   * over the art rather than instead of it (issue #74). A SEPARATE claim from
   * `impactFrames` above: the hit that throws debris is one frame, but a swing
   * can draw several frames of brightness around it — declaring all of them
   * an impact would retrigger the whole spark burst on each one, which reads
   * as continuous debris rather than a single hit. A sheet that names none
   * glows never, the same honest default `impactFrames` uses.
   */
  readonly glowFrames?: readonly number[]
}

/**
 * Whether a clip is part of what the sequence settles into, or plays out and
 * hands over.
 *
 * `loop` used to mean "this one strip repeats for ever", and for a sequence
 * whose settled state is one strip it still does. Since #325 it means the wider
 * thing it always implied: A RUN OF CONSECUTIVE `loop` CLIPS IS ONE CYCLE, and
 * the cycle is what repeats. A dwarf's shift is several strips — pick the pick
 * up, swing (as often as the rank declares), set it down — and it is that whole
 * movement that goes round,
 * not any one strip inside it. A lone `loop` clip is a cycle of one, which is
 * exactly the old behaviour and is why every sequence written before #325 draws
 * identically.
 */
export type SpritePlayback = 'loop' | 'once'

export interface SpriteClip {
  readonly sheet: SpriteSheet
  readonly playback: SpritePlayback
}

export function loopOf(sheet: SpriteSheet): SpriteClip {
  return { sheet, playback: 'loop' }
}

export function onceOf(sheet: SpriteSheet): SpriteClip {
  return { sheet, playback: 'once' }
}

/** Where in a sequence the drawing currently is. */
export interface SequencePosition {
  /** Index of the clip being played. */
  readonly clip: number
  /** Index of the frame within that clip's sheet. */
  readonly frame: number
}

const START: SequencePosition = { clip: 0, frame: 0 }

/**
 * `background-position-x`, in percent, for one frame of a strip.
 *
 * The whole mechanism rests on this. A percentage in `background-position`
 * resolves against (positioning area - image), so with the image stretched to
 * one box per frame the travel is (frames - 1) boxes and frame `i` sits at
 * `i / (frames - 1)` of it. A strip of one frame has no travel at all, which
 * would be a division by zero for an answer that can only ever be 0.
 */
export function framePositionPercent(index: number, frames: number): number {
  if (frames <= 1) return 0
  const clamped = Math.min(Math.max(index, 0), frames - 1)
  return (clamped / (frames - 1)) * 100
}

/** `background-size`, in percent of the sprite box, that the position assumes. */
export function backgroundSizePercent(sheet: SpriteSheet): number {
  return sheet.frames * 100
}

/** Whether this frame is the moment the tool hits the rock. */
export function isImpactFrame(sheet: SpriteSheet, index: number): boolean {
  return sheet.impactFrames?.includes(index) === true
}

/** Whether this frame is bright enough to draw the sprite's own strike glow. */
export function isGlowFrame(sheet: SpriteSheet, index: number): boolean {
  return sheet.glowFrames?.includes(index) === true
}

/**
 * Whether this sequence can never change, and therefore needs no timer at all.
 *
 * The guarantee predates the sheets: a loop of fewer than two frames used to be
 * the silence pose (#47), and a dwarf the panel suspects is dead should cost
 * less to draw than a live one. No sheet drawn so far is single-framed, so
 * nothing real reaches it today — it stays because the next sheet might, and
 * because reduced motion answers the same question in the same shape.
 */
export function sequenceIsStill(clips: readonly SpriteClip[]): boolean {
  if (clips.length > 1) return false
  return (clips[0]?.sheet.frames ?? 0) < 2
}

/** A settled cycle's clips: the first and last of the run, both inclusive. */
export interface SequenceCycle {
  readonly first: number
  readonly last: number
}

/**
 * The clips a sequence settles into, or nothing where it settles on a held
 * frame instead (issue #325).
 *
 * The FIRST run of `loop` clips, because nothing behind a cycle is ever
 * reached: the run stops at the first clip that is not part of it and never
 * picks the loops up again on the other side.
 *
 * Exported because two answers have to agree about it — which frame is showing
 * now (below) and which single frame reduced motion holds (`stillFrameOf` in
 * dwarfSequence.ts). Deriving that twice is how the two would come to disagree.
 */
export function sequenceCycle(clips: readonly SpriteClip[]): SequenceCycle | undefined {
  const first = clips.findIndex((clip) => clip.playback === 'loop')
  if (first < 0) return undefined
  let last = first
  while (clips[last + 1]?.playback === 'loop') last++
  return { first, last }
}

/**
 * The hold every frame of every sheet takes under reduced motion: the per-frame durations are
 * replaced by this flat value, not scaled (motion.md, Reduced motion; decision log, PO ruling
 * 2026-09-25). The dwarfs keep moving; only the shell's own motion stops.
 */
export const REDUCED_MOTION_FRAME_MS = 200

/**
 * How long one frame of a sheet is held: `flatMs` where it is given (reduced motion), else the
 * frame's own duration from the sidecar, else the sheet's `frameMs` fallback (#635).
 */
export function frameDurationMs(sheet: SpriteSheet, index: number, flatMs?: number): number {
  const hold = flatMs ?? sheet.durations?.[index] ?? sheet.frameMs
  return hold > 0 ? hold : 0
}

/** How long one clip takes to play through once. */
function clipDurationMs(clip: SpriteClip, flatMs: number | undefined): number {
  let total = 0
  for (let frame = 0; frame < clip.sheet.frames; frame++) {
    total += frameDurationMs(clip.sheet, frame, flatMs)
  }
  return total
}

/**
 * How long a sequence plays before it settles on its looping tail. Zero for a
 * sequence that opens on a loop, which is every sequence with no transition.
 *
 * A CYCLE'S OWN LAPS ARE NOT PART OF THIS (#325). "Settled" means showing what
 * the sequence will go on showing, and a sequence that opens on a cycle is
 * doing that from its first frame — a shift is the state, not a wind-up into
 * one — so the answer for the four-clip working cycle is zero, exactly as it is
 * for a lone idle loop.
 */
export function sequenceDurationMs(clips: readonly SpriteClip[], flatMs?: number): number {
  let total = 0
  for (const clip of clips) {
    if (clip.playback === 'loop') break
    total += clipDurationMs(clip, flatMs)
  }
  return total
}

/**
 * Where a clip's playhead is, `within` milliseconds into it: the frame, and how long that frame
 * still holds. A time past the clip's end is its last frame with nothing left to hold.
 */
function frameWithin(
  clip: SpriteClip,
  within: number,
  flatMs: number | undefined
): { frame: number; left: number } {
  const { sheet } = clip
  let start = 0
  for (let frame = 0; frame < sheet.frames; frame++) {
    const hold = frameDurationMs(sheet, frame, flatMs)
    if (within < start + hold) return { frame, left: start + hold - within }
    start += hold
  }
  return { frame: Math.max(0, sheet.frames - 1), left: 0 }
}

/**
 * Where the drawing is, this far into the sequence, and how long until it changes — `undefined`
 * where it never will. The one walk both public answers below read, so the frame showing and the
 * moment it next changes can never disagree.
 *
 * A `loop` clip hands the rest of the answer to the CYCLE it belongs to (#325), so a run of loops
 * is one repeating movement and the clips behind that run stay unreachable. The cycle's length is
 * its clips' holds added up, so the position within one lap picks the clip as much as the frame. A
 * cycle with no time in it at all has no position to compute and answers its own head.
 */
function locate(
  clips: readonly SpriteClip[],
  elapsedMs: number,
  flatMs: number | undefined
): { position: SequencePosition; next: number | undefined } {
  if (clips.length === 0) return { position: START, next: undefined }
  const cycle = sequenceCycle(clips)
  let remaining = Math.max(0, elapsedMs)

  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index]!
    if (index === cycle?.first) {
      let total = 0
      let cells = 0
      for (let at = cycle.first; at <= cycle.last; at++) {
        total += clipDurationMs(clips[at]!, flatMs)
        cells += clips[at]!.sheet.frames
      }
      if (total <= 0) return { position: { clip: cycle.first, frame: 0 }, next: undefined }
      // A cycle of one cell shows one picture for ever: nothing ever changes on screen.
      const moves = cells > 1
      let within = remaining % total
      for (let at = cycle.first; at <= cycle.last; at++) {
        const inCycle = clips[at]!
        const duration = clipDurationMs(inCycle, flatMs)
        if (within < duration) {
          const { frame, left } = frameWithin(inCycle, within, flatMs)
          return { position: { clip: at, frame }, next: moves ? left : undefined }
        }
        within -= duration
      }
      return { position: { clip: cycle.first, frame: 0 }, next: moves ? total : undefined }
    }

    const duration = clipDurationMs(clip, flatMs)
    const isLast = index === clips.length - 1
    if (remaining < duration) {
      const { frame, left } = frameWithin(clip, remaining, flatMs)
      // The last frame of the last clip of a sequence that never loops holds for ever.
      const settles = isLast && frame === clip.sheet.frames - 1
      return { position: { clip: index, frame }, next: settles ? undefined : left }
    }
    if (isLast)
      return {
        position: { clip: index, frame: Math.max(0, clip.sheet.frames - 1) },
        next: undefined
      }
    remaining -= duration
  }

  return { position: START, next: undefined }
}

/**
 * Which frame of which clip is showing, this far into the sequence.
 *
 * Time before the start is the start, an empty sequence is the start, and a
 * trailing `once` clip holds its last frame — none of the three is a state the
 * caller has to guard against. `flatMs` is the reduced-motion hold, replacing every
 * frame's own duration (#635).
 *
 * A `loop` clip hands the rest of the answer to the CYCLE it belongs to (#325),
 * so a run of loops is one repeating movement and the clips behind that run
 * stay unreachable, exactly as the clips behind a single looping strip always
 * were.
 */
export function sequenceFrameAt(
  clips: readonly SpriteClip[],
  elapsedMs: number,
  flatMs?: number
): SequencePosition {
  return locate(clips, elapsedMs, flatMs).position
}

/**
 * How long until the drawing next changes, this far into the sequence, or `undefined` where it
 * never will again: a still sequence, or one that has settled on a held last frame (#635). This is
 * what lets the shared frame clock set one timer to the earliest change among every sprite rather
 * than ticking at a fixed rate.
 */
export function sequenceNextChangeMs(
  clips: readonly SpriteClip[],
  elapsedMs: number,
  flatMs?: number
): number | undefined {
  return locate(clips, elapsedMs, flatMs).next
}

/**
 * When a position starts: the holds of every frame before it (#635). How a sprite begins on its
 * phase frame, and how it keeps the frame it is on when the timing switches between the sidecar's
 * durations and the reduced-motion hold.
 */
export function sequenceOffsetMs(
  clips: readonly SpriteClip[],
  position: SequencePosition,
  flatMs?: number
): number {
  let total = 0
  for (let index = 0; index < position.clip && index < clips.length; index++) {
    total += clipDurationMs(clips[index]!, flatMs)
  }
  const sheet = clips[position.clip]?.sheet
  if (sheet === undefined) return total
  for (let frame = 0; frame < position.frame && frame < sheet.frames; frame++) {
    total += frameDurationMs(sheet, frame, flatMs)
  }
  return total
}
