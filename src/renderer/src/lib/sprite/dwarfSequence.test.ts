import { describe, expect, it } from 'vitest'
import type { DwarfRole, DwarfStatus } from '../../types'
import { DWARF_SHEETS } from './dwarfSheets'
import { dwarfClips, isAwaitingAnswer, stillFrameOf } from './dwarfSequence'
import { loopOf, onceOf } from './spriteSheet'

const ROLES: readonly DwarfRole[] = ['worker', 'foreman']

const FOREMAN = DWARF_SHEETS.foreman
const WORKER = DWARF_SHEETS.worker

/** Every sheet a sequence draws from, in order, so a failure names the art. */
function sheetsOf(clips: ReturnType<typeof dwarfClips>): string[] {
  return clips.map((clip) => `${clip.playback}:${clip.sheet.src}`)
}

/*
 * Issue #60's signal, unchanged: only a provider that PROVED a person was asked
 * something selects this. An approval and an open dialog are not questions, and
 * the panel may not single a dwarf out on a reason that merely might mean one.
 */
describe('isAwaitingAnswer', () => {
  it('is true only for a blocked dwarf whose provider proved a human was asked', () => {
    expect(isAwaitingAnswer('waiting', 'user-input')).toBe(true)
  })

  it('leaves every unproven reason alone', () => {
    for (const reason of ['approval', 'unknown', undefined] as const) {
      expect(isAwaitingAnswer('waiting', reason), String(reason)).toBe(false)
    }
  })

  it('never fires for a dwarf that is working or on its way out', () => {
    // The reason rides on a blocked dwarf. A working one is producing and a
    // leaving one is already going; neither is waiting on anybody.
    for (const status of ['working', 'leaving'] as const) {
      expect(isAwaitingAnswer(status, 'user-input'), status).toBe(false)
    }
  })
})

describe('dwarfClips', () => {
  it('idles a dwarf that is not waiting on anyone', () => {
    for (const role of ROLES) {
      expect(sheetsOf(dwarfClips(role, false, false)), role).toEqual(
        sheetsOf([loopOf(DWARF_SHEETS[role].idle)])
      )
    }
  })

  it('idles a dwarf on its very first render, with no previous state to leave', () => {
    for (const role of ROLES) {
      expect(sheetsOf(dwarfClips(role, false, undefined)), role).toEqual(
        sheetsOf([loopOf(DWARF_SHEETS[role].idle)])
      )
    }
  })

  describe('the foreman being asked a question', () => {
    it('falls asleep once, then sleeps on', () => {
      expect(sheetsOf(dwarfClips('foreman', true, false))).toEqual(
        sheetsOf([onceOf(FOREMAN['start-sleep']!), loopOf(FOREMAN.sleeping!)])
      )
    })

    it('wakes once, then goes back to idling', () => {
      expect(sheetsOf(dwarfClips('foreman', false, true))).toEqual(
        sheetsOf([onceOf(FOREMAN['end-sleep']!), loopOf(FOREMAN.idle)])
      )
    })

    it('does not fall asleep a second time while it is still asleep', () => {
      // The transition belongs to the CHANGE, not to the state. Recomputing
      // while nothing moved must not replay it.
      expect(sheetsOf(dwarfClips('foreman', true, true))).toEqual(
        sheetsOf([loopOf(FOREMAN.sleeping!)])
      )
    })

    it('falls asleep on a first render that already finds it asked', () => {
      // A dwarf appearing already blocked has nothing to interrupt, and the
      // fall is what makes the sleep legible rather than a dwarf spawned prone.
      expect(sheetsOf(dwarfClips('foreman', true, undefined))).toEqual(
        sheetsOf([onceOf(FOREMAN['start-sleep']!), loopOf(FOREMAN.sleeping!)])
      )
    })

    it('does not wake a foreman that was never asleep', () => {
      // Nothing to wake from, so playing the waking sheet would be a foreman
      // rousing himself out of a nap he never took.
      expect(sheetsOf(dwarfClips('foreman', false, undefined))).toEqual(
        sheetsOf([loopOf(FOREMAN.idle)])
      )
    })

    /*
     * The interruption rule, stated once here because nothing else states it:
     * A CHANGE OF STATE ALWAYS RESTARTS THE SEQUENCE, AND A TRANSITION CAUGHT
     * MID-PLAY IS ABANDONED WHERE IT STANDS.
     *
     * A question answered while he is still lying down cuts straight to him
     * getting up; asked again while he is getting up cuts straight back to
     * lying down. It is decided entirely by the two booleans, so the same pair
     * always produces the same clips however the dwarf got there — no partial
     * playback to unwind, and no sequence that can strand him half-asleep.
     */
    it('cuts straight to the opposite transition when one is interrupted', () => {
      const fallingAsleep = dwarfClips('foreman', true, false)
      const answeredMidFall = dwarfClips('foreman', false, true)
      expect(sheetsOf(answeredMidFall)[0]).toContain('once:')
      expect(sheetsOf(answeredMidFall)[0]).not.toBe(sheetsOf(fallingAsleep)[0])
    })

    it('is decided by the two states alone, so the same pair always plays the same', () => {
      expect(sheetsOf(dwarfClips('foreman', true, false))).toEqual(
        sheetsOf(dwarfClips('foreman', true, false))
      )
    })
  })

  /*
   * #74's working strips, the same template as the foreman's sleep above,
   * keyed on the dwarf's OWN 'working' status instead of a question asked of
   * it. `working`/`wasWorking` default to false/undefined so every call above
   * this block, written before this axis existed, keeps its exact old meaning.
   */
  describe('a worker starting work', () => {
    it('picks up the pick once, then swings on', () => {
      expect(sheetsOf(dwarfClips('worker', false, false, true, false))).toEqual(
        sheetsOf([onceOf(WORKER['start-working']!), loopOf(WORKER.working!)])
      )
    })

    it('sets the pick down once, then goes back to idling', () => {
      expect(sheetsOf(dwarfClips('worker', false, false, false, true))).toEqual(
        sheetsOf([onceOf(WORKER['end-working']!), loopOf(WORKER.idle)])
      )
    })

    it('does not pick the tool back up while it is still swinging it', () => {
      // Same non-replay guarantee as the foreman's sleep: recomputing while
      // nothing moved must not restart the transition.
      expect(sheetsOf(dwarfClips('worker', false, false, true, true))).toEqual(
        sheetsOf([loopOf(WORKER.working!)])
      )
    })

    it('starts working on a first render that already finds it working', () => {
      // A worker spawned already at the rock has nothing to interrupt, and the
      // pick-up is what makes the start legible rather than a worker spawned
      // mid-swing — the same reasoning as the foreman falling asleep on a
      // first render that already finds him asked.
      expect(sheetsOf(dwarfClips('worker', false, undefined, true, undefined))).toEqual(
        sheetsOf([onceOf(WORKER['start-working']!), loopOf(WORKER.working!)])
      )
    })

    it('does not set down a pick a worker never picked up', () => {
      expect(sheetsOf(dwarfClips('worker', false, undefined, false, undefined))).toEqual(
        sheetsOf([loopOf(WORKER.idle)])
      )
    })

    it('cuts straight to the opposite transition when the start is interrupted', () => {
      // The interruption rule, on the working axis: leaving mid pick-up
      // abandons start-working and goes straight to end-working, whatever
      // frame it had reached.
      const startingWork = dwarfClips('worker', false, false, true, false)
      const leftMidStart = dwarfClips('worker', false, false, false, true)
      expect(sheetsOf(leftMidStart)[0]).toContain('once:')
      expect(sheetsOf(leftMidStart)[0]).not.toBe(sheetsOf(startingWork)[0])
    })

    it('is decided by the two working states alone, so the same pair always plays the same', () => {
      expect(sheetsOf(dwarfClips('worker', false, false, true, false))).toEqual(
        sheetsOf(dwarfClips('worker', false, false, true, false))
      )
    })

    it('lets an interrupted sleep exit finish before any working sequence begins', () => {
      // The ordering that keeps the foreman's wake-up intact: leaving a
      // blocked state is resolved before a newly-true working axis is ever
      // consulted, not the other way round. A worker has no sleep art, so
      // this is invisible for him (idle either way) — it is what stops a
      // FOREMAN's end-sleep transition from being skipped the instant his
      // status flips straight from being asked to 'working'.
      expect(sheetsOf(dwarfClips('foreman', false, true, true, false))).toEqual(
        sheetsOf([onceOf(FOREMAN['end-sleep']!), loopOf(FOREMAN.idle)])
      )
    })

    it('gives the foreman no working sequence, having no working art drawn for him', () => {
      // The foreman's behaviour must not change: he has no start-working,
      // working or end-working sheet, so the axis falls back to his idle
      // exactly the way the sleep axis already falls back for a worker.
      expect(sheetsOf(dwarfClips('foreman', false, false, true, false))).toEqual(
        sheetsOf([loopOf(FOREMAN.idle)])
      )
      expect(sheetsOf(dwarfClips('foreman', false, false, false, true))).toEqual(
        sheetsOf([loopOf(FOREMAN.idle)])
      )
    })
  })

  /*
   * The honest remainder. #74 has now drawn a working sequence (above), which
   * is why this block no longer claims "every state" — only what is left:
   * being asked a question, resting, walking to the vein and walking out
   * (without having worked first) all still fall back to the one idle loop,
   * because none of those has been drawn. Style consistency was chosen over
   * motion fidelity for what remains undrawn, exactly as it was chosen for
   * all four before working landed.
   */
  describe('a worker, whose other loops have not been drawn', () => {
    it('idles through being asked a question, having no sleep art', () => {
      expect(sheetsOf(dwarfClips('worker', true, false))).toEqual(sheetsOf([loopOf(WORKER.idle)]))
    })

    it('plays no transition it does not have, rather than substituting one', () => {
      // Every clip is a loop: a missing transition is DROPPED, never filled
      // with the idle, which would read as a stutter before every state.
      for (const [awaiting, was] of [
        [true, false],
        [false, true],
        [true, true],
        [false, false]
      ] as const) {
        const clips = dwarfClips('worker', awaiting, was)
        expect(
          clips.map((clip) => clip.playback),
          `${awaiting}/${was}`
        ).toEqual(['loop'])
      }
    })

    it('settles on a loop whatever it is doing, so it never freezes on a pose', () => {
      for (const role of ROLES) {
        for (const [awaiting, was] of [
          [true, false],
          [false, true],
          [true, true],
          [false, false]
        ] as const) {
          const clips = dwarfClips(role, awaiting, was)
          expect(clips[clips.length - 1]?.playback, `${role}/${awaiting}/${was}`).toBe('loop')
        }
      }
    })
  })

  it('never borrows the other rank’s art for a state it has none of', () => {
    // The failure #74 named: WALK_ANIMATION was one shared constant, which is
    // exactly why the foreman walked like a miner. A rank falls back to its
    // OWN idle and to nothing else.
    for (const role of ROLES) {
      const other: DwarfRole = role === 'worker' ? 'foreman' : 'worker'
      const otherSheets = Object.values(DWARF_SHEETS[other]).map((sheet) => sheet.src)
      for (const [awaiting, was] of [
        [true, false],
        [false, true]
      ] as const) {
        for (const clip of dwarfClips(role, awaiting, was)) {
          expect(otherSheets, `${role}/${awaiting}/${was}`).not.toContain(clip.sheet.src)
        }
      }
    }
  })
})

/*
 * Issue #71 — a viewer who asked their operating system for less movement gets
 * the whole scene and none of the motion. The frame timer is the largest moving
 * thing on screen, and this is the frame it stops on.
 */
describe('stillFrameOf', () => {
  it('holds the frame the sequence settles on, not the transition into it', () => {
    // A held start-sleep frame is a foreman caught halfway to the floor. What
    // reduced motion should show is the state he ends in.
    const clips = dwarfClips('foreman', true, false)
    expect(stillFrameOf(clips)).toEqual({ clip: 1, frame: FOREMAN.sleeping!.frames - 1 })
  })

  it('holds the last frame of a loop, where its gesture ends', () => {
    // The rule the painted loops used before the sheets landed, kept exactly:
    // the end of the movement rather than the wind-up into it.
    expect(stillFrameOf(dwarfClips('worker', false, false))).toEqual({
      clip: 0,
      frame: WORKER.idle.frames - 1
    })
  })

  it('answers an empty sequence with the first frame rather than throwing', () => {
    expect(stillFrameOf([])).toEqual({ clip: 0, frame: 0 })
  })

  it('holds the working loop mid-shift, and idle once the worker has left it', () => {
    // The reduced-motion contract this task pins: a still worker mid-work
    // shows the swing, not the pick-up it settled from; one that has left
    // shows idle, not the hand-down on the way out.
    const midWork = dwarfClips('worker', false, false, true, false)
    expect(stillFrameOf(midWork)).toEqual({ clip: 1, frame: WORKER.working!.frames - 1 })

    const afterLeaving = dwarfClips('worker', false, false, false, true)
    expect(stillFrameOf(afterLeaving)).toEqual({ clip: 1, frame: WORKER.idle.frames - 1 })
  })

  it('holds a frame the sheet actually has, for every state either rank can be in', () => {
    for (const role of ROLES) {
      for (const [awaiting, was] of [
        [true, false],
        [false, true],
        [true, true],
        [false, false]
      ] as const) {
        const clips = dwarfClips(role, awaiting, was)
        const held = stillFrameOf(clips)
        const sheet = clips[held.clip]?.sheet
        expect(sheet, `${role}/${awaiting}/${was}`).toBeDefined()
        expect(held.frame, `${role}/${awaiting}/${was}`).toBeLessThan(sheet!.frames)
      }
    }
  })
})

/*
 * What the panel can no longer tell apart, pinned so that it is a recorded
 * consequence and not a surprise. Silence (#47), rest (#34) and travel (#19)
 * each selected their own pose off the painted frames; none of them has been
 * drawn as a sheet, so all three now play the rank's idle. The information did
 * not vanish from the panel — the zzz overlay still marks a resting dwarf and
 * the leaving fade still marks a departure — but it is gone from the SPRITE
 * until #74 delivers the art.
 */
describe('states that no longer have a drawing of their own', () => {
  it('narrows to waiting and leaving now that working has its own sequence (#74)', () => {
    // REPLACES the old three-way claim. Working peeled off first — it now
    // plays its own start/loop/end instead of the shared idle. Waiting and
    // leaving still have no art of their own and still draw identically to
    // each other, which is the same claim as before with the one status the
    // art no longer applies to removed.
    const remaining: readonly DwarfStatus[] = ['waiting', 'leaving']
    const drawn = remaining.map((status) =>
      sheetsOf(dwarfClips('worker', isAwaitingAnswer(status, undefined), false)).join()
    )
    expect(new Set(drawn).size).toBe(1)

    const workingDrawn = sheetsOf(dwarfClips('worker', false, false, true, false)).join()
    expect(workingDrawn).not.toBe(drawn[0])
  })

  it('still tells a foreman waiting on a person from a foreman at his post', () => {
    // The one distinction the new art does carry, and the reason the sleep
    // sheets were the first thing drawn.
    expect(sheetsOf(dwarfClips('foreman', true, false))).not.toEqual(
      sheetsOf(dwarfClips('foreman', false, false))
    )
  })
})
