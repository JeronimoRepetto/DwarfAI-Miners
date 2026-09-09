/**
 * One music track's envelope in time (#174): a second of fade-in, a second of
 * fade-out, and a second of silence before the next one starts.
 *
 * Pure, and derived from the track's own duration rather than from a wall
 * clock. That is what keeps the seam accurate whatever rate the engine is
 * ticked at: the fade-out belongs to the last second OF THE TRACK, so it is
 * read off `currentTime` against `duration`, and a tick that arrives late
 * still starts it at the right place in the music.
 */

/** Both fades, and #174 gives them the same length. */
export const MUSIC_FADE_MS = 1000

/** The silence between one track ending and the next beginning. */
export const MUSIC_GAP_MS = 1000

export interface MusicTimeline {
  /** How long the opening fade takes. */
  fadeInMs: number
  /** Where in the track the closing fade begins. */
  fadeOutStartMs: number
  /** How long the closing fade takes. */
  fadeOutMs: number
  /** Where the track ends — its own duration. */
  endMs: number
  /** Where, measured from this track's start, the NEXT track begins. */
  nextStartMs: number
}

/**
 * The timeline for a track of `durationMs`.
 *
 * ## The two cases that are not the ordinary one
 *
 * A track shorter than both fades has them SPLIT down the middle rather than
 * clamped independently. Two independent 1 s fades on a 1.5 s track would
 * overlap for 500 ms, and an envelope that is rising and falling at once has
 * no single answer — halving keeps it continuous, peaking exactly once.
 *
 * A duration that is not a finite positive number gets no end at all, and
 * that is the ordinary first reading rather than an error:
 * `HTMLMediaElement.duration` is `NaN` until the metadata has loaded, so a
 * fade-out scheduled from it would cut a track that had barely started. An
 * infinite `fadeOutStartMs` means "this track has no end I can see" and leaves
 * the element's own `ended` event to drive the gap.
 */
export function musicTimeline(durationMs: number): MusicTimeline {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return {
      fadeInMs: MUSIC_FADE_MS,
      fadeOutStartMs: Number.POSITIVE_INFINITY,
      fadeOutMs: MUSIC_FADE_MS,
      endMs: Number.POSITIVE_INFINITY,
      nextStartMs: Number.POSITIVE_INFINITY
    }
  }
  const fade = Math.min(MUSIC_FADE_MS, durationMs / 2)
  return {
    fadeInMs: fade,
    fadeOutStartMs: durationMs - fade,
    fadeOutMs: fade,
    endMs: durationMs,
    nextStartMs: durationMs + MUSIC_GAP_MS
  }
}

/**
 * The gain at one moment of the track: linear in, full, linear out.
 *
 * Linear rather than an equal-power curve, deliberately. These are fades to
 * and from SILENCE with a second of nothing on either side, not a crossfade
 * between two sources — there is no other signal for a linear ramp to dip
 * against, which is the one artefact an equal-power curve exists to avoid.
 * (The ambience's loop seam IS a crossfade, and it is two ramps over the same
 * two seconds; see ambience.ts.)
 */
export function musicGainAt(positionMs: number, timeline: MusicTimeline): number {
  if (positionMs <= 0) return 0
  if (positionMs < timeline.fadeInMs) return positionMs / timeline.fadeInMs
  if (positionMs < timeline.fadeOutStartMs) return 1
  if (positionMs >= timeline.endMs) return 0
  return 1 - (positionMs - timeline.fadeOutStartMs) / timeline.fadeOutMs
}
