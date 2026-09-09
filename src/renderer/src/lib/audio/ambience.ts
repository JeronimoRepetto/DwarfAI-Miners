/**
 * The mine's room tone, as a pure function of what is on screen (#173, #330).
 *
 * ONE BED. There were two, and which one played was a reading of the crew —
 * `working` while at least one worker was swinging — but that bed was a single
 * recording of "a mine being worked", identical whether one worker or nine were
 * at the rock, and it said nothing about WHO was working or WHEN a pick landed.
 * #330 retires it: the crew makes the mine's noise itself now, one clip per
 * thing a dwarf is drawn doing (see `crew.ts` and `lib/sprite/crewSound.ts`),
 * and what is left here is the quiet room under all of it. So the bed no longer
 * depends on the crew at all, and the only question left is WHETHER an interior
 * is open and audible.
 *
 * With one bed the two-bed crossfade goes too: there is nothing to fade into.
 * The two seconds survive for the LOOP SEAM alone, which is the engine's
 * (#322). A different mine still cuts.
 *
 * All of it lives here rather than in MineScene because none of it is Vue's
 * business, and because the interesting cases are the ones nobody would think
 * to click through by hand: switching mines mid-seam, muting while one is in
 * flight.
 */

/** How long a crossfade takes — the loop seam, which is all that is left (#173). */
export const AMBIENCE_CROSSFADE_MS = 2000

/**
 * The beds, and there is one. Kept as a list rather than collapsed to a string
 * so `AMBIENCE_SRC` still has to name a file for each and the shape survives a
 * second room tone being recorded.
 */
export const AMBIENCE_BEDS = ['silence'] as const

export type AmbienceBed = (typeof AMBIENCE_BEDS)[number]

/**
 * Everything the ambience depends on, and nothing else.
 *
 * The crew is NOT in here any more (#330). It used to carry `working`, a
 * reading of the snapshot, because that decided which of two beds played; the
 * crew now sounds for itself, so the room tone under it depends on nothing but
 * whether there is a room on screen to hear.
 */
export interface AmbienceScene {
  /** The mine whose interior is open, or null when none is. */
  mineId: string | null
  /** The interior's own mute, which silences the ambience alone (#173). */
  muted: boolean
  /** Main's answer about the shell window: minimised or hidden (#174). */
  hidden: boolean
  /** The shell drawn as its bare rail, where only the music survives (#174). */
  collapsed: boolean
}

/** What is playing right now, and in which mine. */
export interface AmbienceStanding {
  mineId: string
  bed: AmbienceBed
}

/**
 * The one act the machine asks for.
 *
 * A `cut` is instant, and that it is never anything else is a decision rather
 * than a simplification: a cut is what a DIFFERENT mine gets, because fading
 * one mine's room out over another mine's interior would be the panel saying
 * something untrue about what is on screen. There used to be a `crossfade`
 * here as well, for the flip between the two beds; it went with the second bed
 * (#330), and the only crossfade left is the loop seam's, which the engine runs
 * without asking this.
 */
export type AmbienceMove =
  { kind: 'none' } | { kind: 'stop' } | { kind: 'cut'; mineId: string; bed: AmbienceBed }

/**
 * Which bed belongs to this scene, or null for silence.
 *
 * The ROOM TONE whenever an interior is open and audible, whatever the crew is
 * doing (#330) — the crew's own clips are what say anything about the crew.
 *
 * Null is NOT the `silence` bed. That bed is a recording of a quiet mine, and
 * with no interior open there is no mine to be quiet — the same distinction
 * between "nothing to say" and "saying nothing happened" that the rest of this
 * panel keeps. It is also the answer the engine reads to decide whether a crew
 * clip may be opened at all: the crew is audible exactly when the room it is
 * standing in is.
 */
export function ambienceBedFor(scene: AmbienceScene): AmbienceBed | null {
  if (scene.mineId === null) return null
  if (scene.muted || scene.hidden || scene.collapsed) return null
  return 'silence'
}

/**
 * What to do about the difference between what is playing and what should be.
 *
 * A mine change is a CUT, and that is the one decision in here: fading one
 * mine's room out under another mine's interior would be the panel saying
 * something untrue about what is on screen. With a single bed there is no
 * other change left to make — a bed replacing itself in the same mine is the
 * loop seam, which belongs to the engine and to #322.
 */
export function ambienceMove(
  standing: AmbienceStanding | null,
  scene: AmbienceScene
): AmbienceMove {
  const bed = ambienceBedFor(scene)
  if (bed === null) return standing === null ? { kind: 'none' } : { kind: 'stop' }
  // `scene.mineId` is a string here: ambienceBedFor already refused a null one.
  const mineId = scene.mineId as string
  if (standing === null) return { kind: 'cut', mineId, bed }
  if (standing.mineId !== mineId) return { kind: 'cut', mineId, bed }
  return { kind: 'none' }
}

/**
 * Whether a bed is close enough to its end to start the loop crossfade.
 *
 * Still true PAST the seam, so a tick that arrives late runs it rather than
 * skipping it — a missed seam is an audible gap, which is exactly what the
 * crossfade exists to avoid.
 *
 * A duration that is not a finite positive number says nothing (it is `NaN`
 * until the metadata loads, see musicTimeline), and neither does a bed shorter
 * than the crossfade itself: such a bed would be seaming from the moment it
 * began, so it would never play. Neither committed bed is anywhere near that
 * short; the guard is here so a future one cannot loop on itself forever.
 */
export function shouldCrossfadeLoopSeam(positionMs: number, durationMs: number): boolean {
  if (!Number.isFinite(durationMs) || durationMs <= AMBIENCE_CROSSFADE_MS) return false
  return positionMs >= durationMs - AMBIENCE_CROSSFADE_MS
}
