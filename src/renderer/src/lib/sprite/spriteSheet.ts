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
 * that plays once hands over to the loop behind it — falling asleep into
 * sleeping, waking into idle. The last clip is where the sequence settles: a
 * `loop` there runs for ever, a `once` holds its final frame rather than
 * replaying a gesture as though it were an idle.
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
  /** How long each frame is held. */
  readonly frameMs: number
  /**
   * The frames on which the tool bites the rock. Sparks fire on these and
   * nowhere else, so a sheet that names none throws none — which is the honest
   * answer while the only sheets drawn are idles (issue #74).
   */
  readonly impactFrames?: readonly number[]
}

/** Whether a clip runs for ever or plays out and hands over. */
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

/**
 * How long a sequence plays before it settles on its looping tail. Zero for a
 * sequence that opens on a loop, which is every sequence with no transition.
 */
export function sequenceDurationMs(clips: readonly SpriteClip[]): number {
  let total = 0
  for (const clip of clips) {
    if (clip.playback === 'loop') break
    total += clip.sheet.frames * clip.sheet.frameMs
  }
  return total
}

/**
 * Which frame of which clip is showing, this far into the sequence.
 *
 * Time before the start is the start, an empty sequence is the start, and a
 * trailing `once` clip holds its last frame — none of the three is a state the
 * caller has to guard against.
 */
export function sequenceFrameAt(clips: readonly SpriteClip[], elapsedMs: number): SequencePosition {
  if (clips.length === 0) return START
  let remaining = Math.max(0, elapsedMs)

  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index]
    if (clip === undefined) break
    const { frames, frameMs } = clip.sheet
    const played = frameMs > 0 ? Math.floor(remaining / frameMs) : 0

    if (clip.playback === 'loop') {
      return { clip: index, frame: frames > 0 ? played % frames : 0 }
    }

    const isLast = index === clips.length - 1
    if (played < frames) return { clip: index, frame: played }
    if (isLast) return { clip: index, frame: Math.max(0, frames - 1) }
    remaining -= frames * frameMs
  }

  return START
}
