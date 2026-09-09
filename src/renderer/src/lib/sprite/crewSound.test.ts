import { describe, expect, it } from 'vitest'
import type { DwarfRole } from '../../types'
import { crewEndingSignal, crewFrameSignals, crewWalkSignal } from './crewSound'
import { dwarfClips } from './dwarfSequence'
import { DWARF_CREW, DWARF_SHEETS } from './dwarfSheets'
import type { SequencePosition } from './spriteSheet'

const ROLES: readonly DwarfRole[] = ['worker', 'worker2', 'foreman']

/** The shift cycle a rank at the rock plays, which is what the cues read. */
function cycle(role: DwarfRole) {
  return dwarfClips(role, false, false, true, false)
}

/** One step of the drawing, from one position to the next. */
function step(
  role: DwarfRole,
  previous: SequencePosition | undefined,
  now: SequencePosition
): ReturnType<typeof crewFrameSignals> {
  return crewFrameSignals(role, cycle(role), previous, now)
}

describe('crewFrameSignals — the strike (#330)', () => {
  it('sounds on the frame the sheet already calls an impact', () => {
    // Clip 1 is the first swing, frame 4 the declared impact — the same frame
    // the sparks fire on, so the sound and the debris are one event.
    expect(step('worker', { clip: 1, frame: 3 }, { clip: 1, frame: 4 })).toEqual([
      { cue: 'strike' }
    ])
  })

  it('sounds on BOTH swings of the shift, not only the first', () => {
    // The second swing is a clip of its own drawn from the same strip (#325),
    // so the declaration reaches it without naming it.
    expect(step('worker', { clip: 2, frame: 3 }, { clip: 2, frame: 4 })).toEqual([
      { cue: 'strike' }
    ])
  })

  it('says nothing on any other frame of the swing', () => {
    for (const frame of [0, 1, 2, 3, 5, 6, 12]) {
      expect(step('worker', { clip: 1, frame: frame - 1 }, { clip: 1, frame }), `${frame}`).toEqual(
        []
      )
    }
  })

  it('says nothing on the pick-up or the set-down, which declare no impact', () => {
    expect(step('worker', { clip: 0, frame: 0 }, { clip: 0, frame: 1 })).toEqual([])
    expect(step('worker', { clip: 3, frame: 3 }, { clip: 3, frame: 4 })).toEqual([])
  })

  it('needs no previous position: a strike is the frame showing, not a crossing', () => {
    expect(step('worker', undefined, { clip: 1, frame: 4 })).toEqual([{ cue: 'strike' }])
  })

  it('leaves the worker2 silent at the rock, its strips declaring no impact', () => {
    // It carries no pick (#211), so there is no hit to sound — its whole
    // shift is one sound instead, below.
    const clips = cycle('worker2')
    for (let clip = 0; clip < clips.length; clip++) {
      for (const frame of [0, 4, 9]) {
        const signals = step('worker2', { clip, frame: 0 }, { clip, frame })
        expect(
          signals.filter((signal) => signal.cue === 'strike'),
          `${clip}/${frame}`
        ).toEqual([])
      }
    }
  })
})

describe('crewFrameSignals — the shift (#330)', () => {
  const CUE = DWARF_CREW.worker2.sound!.shift!

  it('sounds as the pick-up crosses the declared frame', () => {
    expect(
      step('worker2', { clip: 0, frame: CUE.frame - 1 }, { clip: 0, frame: CUE.frame })
    ).toEqual([{ cue: 'shift' }])
  })

  it('sounds even when the tick skips the declared frame outright', () => {
    // A late tick lands on frame 15 with frame 14 never drawn. The cue is a
    // CROSSING rather than an equality for exactly this: a grind that silently
    // did not start is a worker2 miming its whole shift.
    expect(step('worker2', { clip: 0, frame: 13 }, { clip: 0, frame: 15 })).toEqual([
      { cue: 'shift' }
    ])
  })

  it('sounds once per shift, not again on every later frame of the pick-up', () => {
    expect(step('worker2', { clip: 0, frame: CUE.frame }, { clip: 0, frame: 15 })).toEqual([])
  })

  it('says nothing while the pick-up has not reached the frame yet', () => {
    for (let frame = 1; frame < CUE.frame; frame++) {
      expect(
        step('worker2', { clip: 0, frame: frame - 1 }, { clip: 0, frame }),
        `${frame}`
      ).toEqual([])
    }
  })

  it('says nothing on the swings or the set-down, whatever frame they reach', () => {
    // The cue names ONE strip. The swing's frame 14 does not exist and the
    // set-down's does, which is exactly why the strip is part of the
    // declaration rather than the frame alone.
    expect(step('worker2', { clip: 1, frame: 0 }, { clip: 1, frame: 9 })).toEqual([])
    expect(step('worker2', { clip: 9, frame: 13 }, { clip: 9, frame: 15 })).toEqual([])
  })

  it('says nothing when the sequence has just restarted onto the pick-up', () => {
    // Wrapping from the set-down back to frame 0 is not a crossing of frame
    // 14; the shift sounds a few frames later, when it gets there.
    expect(step('worker2', { clip: 9, frame: 16 }, { clip: 0, frame: 0 })).toEqual([])
  })

  it('sounds again on the next shift, a restart being a new shift', () => {
    // Nothing here remembers having fired, which is what makes the second lap
    // — and a re-render that restarts the sequence — a shift of its own. A
    // flag would outlive the shift it described, exactly as #322's seam flag
    // outlived its bed.
    const crossing = () => step('worker2', { clip: 0, frame: 13 }, { clip: 0, frame: 14 })
    expect(crossing()).toEqual([{ cue: 'shift' }])
    expect(crossing()).toEqual([{ cue: 'shift' }])
  })

  it('needs a previous position, a crossing being the whole of it', () => {
    expect(step('worker2', undefined, { clip: 0, frame: 14 })).toEqual([])
  })

  it('leaves the worker without one, its shift being a run of strikes', () => {
    const clips = cycle('worker')
    for (let clip = 0; clip < clips.length; clip++) {
      const signals = crewFrameSignals('worker', clips, { clip, frame: 0 }, { clip, frame: 4 })
      expect(
        signals.filter((signal) => signal.cue === 'shift'),
        `${clip}`
      ).toEqual([])
    }
  })
})

describe('crewFrameSignals — the foreman', () => {
  it('says nothing at all, having declared neither cue', () => {
    // His `working` is a session producing tokens, not a pick on a rock, and
    // he has no working art for a frame cue to read (#173's own example).
    const clips = cycle('foreman')
    for (const frame of [0, 4, 5]) {
      expect(crewFrameSignals('foreman', clips, { clip: 0, frame: 0 }, { clip: 0, frame })).toEqual(
        []
      )
    }
  })
})

describe('crewFrameSignals — a position off the end of the sequence', () => {
  it('says nothing rather than reading a clip that is not there', () => {
    expect(step('worker', { clip: 99, frame: 3 }, { clip: 99, frame: 4 })).toEqual([])
  })
})

describe('crewWalkSignal (#330)', () => {
  it('opens the footsteps at the gain the rank declared', () => {
    const declared = DWARF_CREW.worker.sound!.walk!
    expect(crewWalkSignal('worker')).toEqual({ cue: 'walk', gain: declared.gain })
  })

  it('gives every rank the same footsteps, the foreman included', () => {
    // The one crew cue that is not a frame: it is the walk, and every rank
    // walks — including the one with no working art at all.
    for (const role of ROLES) {
      expect(crewWalkSignal(role), role).toEqual({ cue: 'walk', gain: 0.05 })
    }
  })

  it('is the declaration and nothing else, so a rank without one is silent', () => {
    // Read through the table rather than case by case, so a rank added
    // without a walk declaration falls out here instead of at the ear.
    for (const role of ROLES) {
      const declared = DWARF_CREW[role].sound?.walk
      expect(crewWalkSignal(role), role).toEqual(
        declared === undefined ? undefined : { cue: 'walk', gain: declared.gain }
      )
    }
  })

  it('is quieter than everything else the crew does, by a wide margin', () => {
    // Texture, not an event. Pinned as a comparison rather than as 0.05 twice:
    // the number itself is `dwarfSheets.ts`'s to state.
    expect(DWARF_CREW.worker.sound!.walk!.gain).toBeLessThan(0.2)
    expect(DWARF_SHEETS.worker.working?.impactFrames).toBeDefined()
  })
})

describe('crewEndingSignal (#330)', () => {
  it('ends a cue the rank declared, carrying no gain to open anything at', () => {
    expect(crewEndingSignal('worker', 'walk')).toEqual({ cue: 'walk', ending: true })
    expect(crewEndingSignal('worker2', 'shift')).toEqual({ cue: 'shift', ending: true })
  })

  it('says nothing for a cue the rank never declared', () => {
    // A rank that cannot open a cue has none to close, so the ear is never
    // asked to release something no sprite started.
    expect(crewEndingSignal('worker', 'shift')).toBeUndefined()
    expect(crewEndingSignal('foreman', 'shift')).toBeUndefined()
    expect(crewEndingSignal('foreman', 'strike')).toBeUndefined()
  })

  it('will end a strike too, though nothing ever asks it to', () => {
    // A strike is over in half a second and there is nothing to release; this
    // is the shape being uniform rather than a case anybody uses.
    expect(crewEndingSignal('worker', 'strike')).toEqual({ cue: 'strike', ending: true })
  })
})
