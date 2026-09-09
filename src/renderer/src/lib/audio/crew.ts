/**
 * The crew's own sounds, as rules rather than as sound (issue #330).
 *
 * The mine's `working` bed (#173) is retired: it was one recording of "a mine
 * being worked", identical whether one worker or nine were at the rock, and it
 * said nothing about WHO was working or WHEN a pick landed. The crew makes the
 * mine's noise now, one clip per thing a dwarf is drawn doing — so what used to
 * be a single bed is a handful of short clips arriving from nine sprites at
 * once, and these are the three rules that keeps honest.
 *
 * `lib/sprite/crewSound.ts` decides WHEN a cue fires, off the frames. This
 * decides what a crowd of them is allowed to do. The engine holds the clips.
 */
import type { DwarfRole } from '../../types'
import type { CrewSoundSignal } from '../sprite/crewSound'

/**
 * How many crew clips may sound at once.
 *
 * A FOURTH CUE IS DROPPED, NEVER QUEUED. A queue would pay back a strike a
 * second after the pick that threw it had already lifted again, which is the
 * one thing worse than not hearing it: nine workers would drift into a drum
 * machine playing a mine that had moved on. A missing strike in a busy mine is
 * inaudible; a rattle is not.
 *
 * Three is also what keeps the element player honest — see the note on the
 * player in `engine.ts`.
 */
export const CREW_POLYPHONY = 3

/**
 * How long a sustained clip takes to fade out when its movement stops.
 *
 * A CUT would be audible: the grind and the footsteps are both recordings of
 * a continuous motion, so stopping one dead leaves a click where the movement
 * ended. Short enough that a dwarf that has stopped walking is not still heard
 * walking, long enough that the stop is a stop and not an edit.
 */
export const CREW_RELEASE_MS = 300

/**
 * One cue with everything the engine needs to place it: which mine it came
 * from, which dwarf made it, and which rank that dwarf is.
 *
 * The mine matters because a cue arriving from a scene the viewer has already
 * left must open nothing — what you hear is what is drawn. The dwarf matters
 * because a sustained clip has to be released by the same dwarf that opened
 * it, and because it is what fixes which footsteps that dwarf wears.
 */
export interface CrewSoundEvent extends CrewSoundSignal {
  readonly mineId: string
  readonly dwarfId: string
  readonly role: DwarfRole
}

/**
 * Which of a cue's recordings this dwarf uses, stable for as long as it lives.
 *
 * A hash of the id rather than a draw from the injected `random`, and the
 * difference is the whole requirement: the footsteps a dwarf walks in on must
 * be the footsteps it leaves in, minutes later, with nothing remembered in
 * between — and nothing here IS remembered. A per-dwarf seed would have to be
 * stored somewhere and would then have to be evicted somewhere, which is a
 * cache for an answer arithmetic already gives.
 *
 * FNV-1a, which is deliberately not the id itself: session ids arrive in bursts
 * of near-identical strings, so "the last character modulo two" would hand a
 * whole mine one pair of boots and its neighbour the other. Every cue is picked
 * this way, so a cue with a single recording answers 0 for everybody without a
 * special case anywhere else.
 */
export function crewVariantIndex(dwarfId: string, count: number): number {
  if (count <= 1) return 0
  let hash = 2166136261
  for (let index = 0; index < dwarfId.length; index++) {
    hash ^= dwarfId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash % count)
}
