/**
 * What a crew member's drawing just did that the ear should know about
 * (issue #330).
 *
 * The crew IS the mine's sound now: the `working` ambience bed was one
 * recording of "a mine being worked", the same whether one worker or nine were
 * at the rock, and it said nothing about WHO was working or WHEN a pick landed.
 * So the sounds are read off the frames the sprites are actually drawing, and
 * this is the reading — pure, framework-free, and the only place that knows
 * which frame means which cue.
 *
 * Every answer comes out of `DWARF_CREW`'s declarations (`dwarfSheets.ts`).
 * NOTHING HERE BRANCHES ON THE RANK, and that is the point: a worker strikes
 * and a worker2 grinds because their sheets say so. A rank that declares
 * nothing is silent, which is the foreman at the rock.
 *
 * Which recording a cue opens, how loud it ends up and whether it is audible
 * at all are none of this file's business — see `lib/audio/crew.ts` and the
 * engine. This says only "a strike just landed".
 */
import type { DwarfRole } from '../../types'
import { DWARF_CREW, DWARF_SHEETS } from './dwarfSheets'
import { isImpactFrame, type SequencePosition, type SpriteClip } from './spriteSheet'

/** The three things a crew member does that make a sound. */
export type CrewCue = 'strike' | 'shift' | 'walk'

/**
 * One cue, on its way to the ear.
 *
 * `ending` is what closes a SUSTAINED cue — the grind and the footsteps both
 * run for as long as the movement does, so both need a way to stop that is not
 * the recording running out. A strike never ends: it is over in half a second
 * and there is nothing to release.
 */
export interface CrewSoundSignal {
  readonly cue: CrewCue
  /** The gain the rank declared for this cue; absent means its own full level. */
  readonly gain?: number
  /** True to RELEASE what this cue opened, rather than to open anything. */
  readonly ending?: boolean
}

/**
 * The cues this step of the drawing fires, if any.
 *
 * Called for a change of position and nothing else, so `previous` is where the
 * drawing was one step ago — `undefined` only on a first reading, where there
 * is no step to have taken.
 *
 * A STRIKE IS A FRAME AND A SHIFT IS A CROSSING, and the difference is not a
 * detail. A strike belongs to the frame showing, so it needs no history: the
 * hit is drawn, the sound is drawn with it. A shift belongs to a MOMENT inside
 * a strip that plays for a second and a half, and a tick that arrives late can
 * step straight over the exact frame it names — so it fires when the position
 * moves from below that frame to at or past it, within the same clip. A grind
 * that silently failed to start is a worker2 miming its entire shift; one that
 * fires a frame late is inaudible.
 *
 * Nothing is remembered between calls, which is what makes the next lap — and
 * a re-render that restarts the sequence — a shift of its own. A flag saying
 * "already fired" would outlive the shift it described, exactly as #322's seam
 * flag outlived its bed.
 */
export function crewFrameSignals(
  role: DwarfRole,
  clips: readonly SpriteClip[],
  previous: SequencePosition | undefined,
  now: SequencePosition
): readonly CrewSoundSignal[] {
  const declared = DWARF_CREW[role].sound
  if (declared === undefined) return []
  const sheet = clips[now.clip]?.sheet
  if (sheet === undefined) return []

  const signals: CrewSoundSignal[] = []
  // The sheet's own `impactFrames`, never a frame named again here: the strike
  // and the sparks it throws are one event and must not be able to drift.
  if (declared.strike !== undefined && isImpactFrame(sheet, now.frame)) {
    signals.push({ cue: 'strike' })
  }

  const shift = declared.shift
  if (
    shift !== undefined &&
    previous !== undefined &&
    previous.clip === now.clip &&
    // The declaration names a STRIP as well as a frame, because the same frame
    // number exists in several of them: the worker2's set-down has a frame 14
    // too, and it is not where a grind begins.
    sheet.src === DWARF_SHEETS[role][shift.sheet]?.src &&
    previous.frame < shift.frame &&
    now.frame >= shift.frame
  ) {
    signals.push({ cue: 'shift' })
  }
  return signals
}

/**
 * The footsteps starting, or nothing where the rank declared none.
 *
 * THE ONE CUE THAT IS NOT A FRAME, which is why it takes no position at all: a
 * walk is the scene moving the sprite across the interior, and the sprite goes
 * on drawing its idle throughout. That is also why it is the one crew cue a
 * viewer who asked for less movement still hears — the frames stop for them,
 * the crossing of the floor does not.
 */
export function crewWalkSignal(role: DwarfRole): CrewSoundSignal | undefined {
  const declared = DWARF_CREW[role].sound?.walk
  if (declared === undefined) return undefined
  return { cue: 'walk', gain: declared.gain }
}

/**
 * The end of a sustained cue, or nothing where the rank declared none.
 *
 * A sustained recording outlives the movement it belongs to — the grind runs
 * 8.53 s and the footsteps far longer than any walk — so both need saying when
 * to stop, and neither may be left to run out on its own. Guarded by the
 * DECLARATION rather than by anything remembered: a rank that cannot open a
 * cue has none to close, so the ear is never asked to release something no
 * sprite ever started.
 */
export function crewEndingSignal(role: DwarfRole, cue: CrewCue): CrewSoundSignal | undefined {
  if (DWARF_CREW[role].sound?.[cue] === undefined) return undefined
  return { cue, ending: true }
}
