/**
 * The mine's ambience, as a pure function of what is on screen (#173).
 *
 * Two beds and two rules. WHICH bed is a reading of the crew — `working` while
 * at least one worker is swinging, `silence` otherwise — and HOW it changes
 * depends on whether the mine itself changed: a bed replacing another bed in
 * the same mine crossfades over two seconds, and a different mine cuts.
 *
 * All of it lives here rather than in MineScene because none of it is Vue's
 * business, and because the interesting cases are the ones nobody would think
 * to click through by hand: a mine with only a foreman, a mine whose workers
 * are all resting, switching mines mid-crossfade, muting while a flip is in
 * flight.
 */
import type { DwarfRole, DwarfStatus } from '../../types'

/** How long a crossfade takes — the loop seam and a state flip alike (#173). */
export const AMBIENCE_CROSSFADE_MS = 2000

export const AMBIENCE_BEDS = ['working', 'silence'] as const

export type AmbienceBed = (typeof AMBIENCE_BEDS)[number]

/**
 * Everything the ambience depends on, and nothing else.
 *
 * `working` is a boolean rather than the crew itself, so the reading of the
 * snapshot (`hasWorkingWorker`) is separable from the decision about the bed —
 * they fail differently and they are tested apart.
 */
export interface AmbienceScene {
  /** The mine whose interior is open, or null when none is. */
  mineId: string | null
  /** Whether at least one worker in THAT mine is working. */
  working: boolean
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
 * `cut` is instant and `crossfade` is not, and the difference is never a
 * matter of taste: a cut is what a DIFFERENT mine gets, because fading one
 * mine's crew out over another mine's interior would be the panel saying
 * something untrue about what is on screen.
 */
export type AmbienceMove =
  | { kind: 'none' }
  | { kind: 'stop' }
  | { kind: 'cut'; mineId: string; bed: AmbienceBed }
  | { kind: 'crossfade'; mineId: string; bed: AmbienceBed; ms: number }

/**
 * Whether any of the crew is actually mining.
 *
 * A FOREMAN DOES NOT COUNT, and that is #173's own example rather than an
 * omission: a mine with only a foreman hears `silence`. The foreman's
 * `working` is a session producing tokens; the working bed is picks on rock,
 * which is what the workers are drawn doing. Read off the same snapshot the
 * sprites read, and never inferred from anything else.
 */
export function hasWorkingWorker(
  crew: readonly { role: DwarfRole; status: DwarfStatus }[]
): boolean {
  return crew.some(
    (dwarf) => (dwarf.role === 'worker' || dwarf.role === 'worker2') && dwarf.status === 'working'
  )
}

/**
 * Which bed belongs to this scene, or null for silence.
 *
 * Null is NOT the `silence` bed. That bed is a recording of a quiet mine, and
 * with no interior open there is no mine to be quiet — the same distinction
 * between "nothing to say" and "saying nothing happened" that the rest of this
 * panel keeps.
 */
export function ambienceBedFor(scene: AmbienceScene): AmbienceBed | null {
  if (scene.mineId === null) return null
  if (scene.muted || scene.hidden || scene.collapsed) return null
  return scene.working ? 'working' : 'silence'
}

/**
 * What to do about the difference between what is playing and what should be.
 *
 * The order of the checks is the contract. A mine change is tested BEFORE the
 * bed change, so switching from one mine's `working` to another mine's
 * `working` is still a cut — the bed is the same and the mine is not, and the
 * mine is what decides.
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
  if (standing.bed !== bed) return { kind: 'crossfade', mineId, bed, ms: AMBIENCE_CROSSFADE_MS }
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
