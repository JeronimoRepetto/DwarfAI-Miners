import { describe, expect, it } from 'vitest'
import type { DwarfRole, DwarfStatus } from '../../types'
import { DWARF_SHEETS } from './dwarfSheets'
import { dwarfClips, isResting, stillFrameOf } from './dwarfSequence'
import { loopOf, onceOf } from './spriteSheet'

const ROLES: readonly DwarfRole[] = ['worker', 'foreman']

const FOREMAN = DWARF_SHEETS.foreman
const WORKER = DWARF_SHEETS.worker
const WORKER2 = DWARF_SHEETS.worker2

/** Every sheet a sequence draws from, in order, so a failure names the art. */
function sheetsOf(clips: ReturnType<typeof dwarfClips>): string[] {
  return clips.map((clip) => `${clip.playback}:${clip.sheet.src}`)
}

/*
 * REMOVED for #306: `isAwaitingAnswer(status, waitingReason)`, which required
 * a provider to have PROVED a human was asked something before the marker's
 * OWN predicate — `status === 'waiting'` — could be trusted for the sleep
 * SEQUENCE too. That was the bug: a foreman resting at his prompt with no
 * such proof was marked asleep by `DwarfStatusIcons` and drawn awake by this
 * module. Three cases went with it: "is true only for a blocked dwarf whose
 * provider proved a human was asked", "leaves every unproven reason alone"
 * (the case that pinned the bug as if it were correct — `isAwaitingAnswer('waiting',
 * undefined)` was `false`) and "never fires for a dwarf that is working or on
 * its way out". `isResting` below replaces it, has no `waitingReason`
 * parameter to get wrong, and is exercised the same way.
 */
describe('isResting', () => {
  it('is true for a waiting dwarf, with no reason required at all (#306)', () => {
    // isResting takes no waitingReason — there is nothing here FOR a reason
    // to gate. That absence of a parameter is the fix.
    expect(isResting('waiting')).toBe(true)
  })

  it('is false for a dwarf that is working or on its way out', () => {
    for (const status of ['working', 'leaving'] as const) {
      expect(isResting(status), status).toBe(false)
    }
  })
})

/*
 * The regression itself (#306), composed the exact way `DwarfSprite.vue`'s
 * watch feeds `dwarfClips` — `isResting(status)` straight in, no reason
 * required. Before this fix a foreman blocked at his prompt with no PROVEN
 * reason (no `waitingReason` at all, or one other than `'user-input'`) was
 * marked asleep by `DwarfStatusIcons`' marker and left idling by this
 * sequence, because `isAwaitingAnswer('waiting', undefined)` was `false`.
 * `isResting` did not exist before this fix, so every case here fails to
 * even compile against the pre-fix module — which is the correct failure: the
 * fix IS `isResting` existing and `dwarfClips` reading it.
 */
describe('the sleep axis reads REST, not a proven reason (#306)', () => {
  it('falls asleep entering rest with no waitingReason offered at all', () => {
    expect(sheetsOf(dwarfClips('foreman', isResting('waiting'), false))).toEqual(
      sheetsOf([onceOf(FOREMAN['start-sleep']!), loopOf(FOREMAN.sleeping!)])
    )
  })

  it('wakes leaving rest for idle', () => {
    expect(sheetsOf(dwarfClips('foreman', isResting('leaving'), true))).toEqual(
      sheetsOf([onceOf(FOREMAN['end-sleep']!), loopOf(FOREMAN.idle)])
    )
  })

  it('wakes leaving rest straight for work, end-sleep resolving before the working axis gets a say', () => {
    expect(sheetsOf(dwarfClips('foreman', isResting('working'), true, true, false))).toEqual(
      sheetsOf([onceOf(FOREMAN['end-sleep']!), loopOf(FOREMAN.idle)])
    )
  })

  it('idles a resting worker, having no sleep strips of its own', () => {
    expect(sheetsOf(dwarfClips('worker', isResting('waiting'), false))).toEqual(
      sheetsOf([loopOf(WORKER.idle)])
    )
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

  /*
   * AMENDED for #306: this block was 'the foreman being asked a question',
   * and its cases called the first two dwarfClips arguments `awaiting` /
   * `wasAwaiting` in spirit — the boolean was meant to answer "did a provider
   * prove someone asked him something". It now answers "is he resting", full
   * stop, which is why the assertions below are untouched: dwarfClips's own
   * mechanics never depended on WHERE the boolean came from, only on its
   * value, and that is exactly what this block still pins.
   */
  describe('the foreman entering and leaving rest', () => {
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

    it('falls asleep on a first render that already finds it resting', () => {
      // A dwarf appearing already resting has nothing to interrupt, and the
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
     * Rest ending while he is still lying down cuts straight to him getting
     * up; rest starting again while he is getting up cuts straight back to
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
   * keyed on the dwarf's OWN 'working' status instead of whether it is
   * resting. `working`/`wasWorking` default to false/undefined so every call
   * above this block, written before this axis existed, keeps its exact old
   * meaning.
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
      // status flips straight from 'waiting' to 'working'.
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
   * Issue #262 reverses #74's "status decides the sheet" ruling, pinned by
   * the block above (unchanged — every call there omits `arrived`, which
   * defaults to `true`, so it keeps meaning exactly what it always did).
   * Arrival, not status, now gates entry to the working sequence: the sparks
   * and the strike glow already refused a walking dwarf (see `impactCount`
   * and `strikeGlow` in DwarfSprite.vue), and the sequence was the one thing
   * still contradicting the scene.
   */
  describe('arrival gates the working sequence (#262)', () => {
    it('idles a working dwarf that has not arrived yet', () => {
      // Working status alone used to be enough for #74; it no longer is.
      expect(sheetsOf(dwarfClips('worker', false, false, true, false, false))).toEqual(
        sheetsOf([loopOf(WORKER.idle)])
      )
    })

    it('starts the working sequence on arrival, the same entry as a dwarf that was already standing', () => {
      const onArrival = dwarfClips('worker', false, false, true, false, true)
      expect(sheetsOf(onArrival)).toEqual(
        sheetsOf([onceOf(WORKER['start-working']!), loopOf(WORKER.working!)])
      )
      // Arriving already working and starting to work while already standing
      // are the same starting line — neither has anything to interrupt.
      const becameWorkingStanding = dwarfClips('worker', false, false, true, false)
      expect(sheetsOf(onArrival)).toEqual(sheetsOf(becameWorkingStanding))
    })

    it('drops a worker that stops mid-walk straight to idle, with no end strip to abandon', () => {
      // It was never SHOWN working — walking gated it off, the case above —
      // so there is nothing for an end-working transition to leave.
      expect(sheetsOf(dwarfClips('worker', false, false, false, false, false))).toEqual(
        sheetsOf([loopOf(WORKER.idle)])
      )
    })

    it('ends the working sequence once a dwarf that was showing it starts walking away', () => {
      // The symmetric case: a dwarf that WAS at the rock and is re-routed
      // mid-swing is abandoned exactly the way an ordinary stop abandons it —
      // the interruption rule from the header applies to arrival too.
      expect(sheetsOf(dwarfClips('worker', false, false, true, true, false))).toEqual(
        sheetsOf([onceOf(WORKER['end-working']!), loopOf(WORKER.idle)])
      )
    })

    it('keeps every call site written before #262 meaning exactly what it always did', () => {
      // `arrived` defaults to `true`, so a caller with nothing to say about
      // travel — every test above this block — gets the pre-#262 behaviour
      // verbatim.
      expect(sheetsOf(dwarfClips('worker', false, false, true, false))).toEqual(
        sheetsOf(dwarfClips('worker', false, false, true, false, true))
      )
    })

    it('gates worker2 exactly the same way, having its own working sequence too', () => {
      // dwarfClips has no per-role branch beyond the DWARF_SHEETS lookup, so
      // the gate is not something worker2 could opt out of even by accident
      // — this pins it rather than trusting that by inspection alone.
      expect(sheetsOf(dwarfClips('worker2', false, false, true, false, false))).toEqual(
        sheetsOf([loopOf(WORKER2.idle)])
      )
      expect(sheetsOf(dwarfClips('worker2', false, false, true, false, true))).toEqual(
        sheetsOf([onceOf(WORKER2['start-working']!), loopOf(WORKER2.working!)])
      )
    })

    it('leaves the foreman untouched, having no working sequence for arrival to gate', () => {
      // #262 only ever changes a role that draws start-working/working/end-
      // working; the foreman draws none, so `arrived` has nothing to do for
      // him and the pre-existing "no working sequence" fallback is unchanged
      // whether or not he has arrived.
      expect(sheetsOf(dwarfClips('foreman', false, false, true, false, false))).toEqual(
        sheetsOf([loopOf(FOREMAN.idle)])
      )
      expect(sheetsOf(dwarfClips('foreman', false, false, true, false, true))).toEqual(
        sheetsOf([loopOf(FOREMAN.idle)])
      )
    })
  })

  /*
   * The honest remainder. #74 has now drawn a working sequence (above), which
   * is why this block no longer claims "every state" — only what is left:
   * resting, walking to the vein and walking out (without having worked
   * first) all still fall back to the one idle loop, because none of those
   * has been drawn. Style consistency was chosen over motion fidelity for
   * what remains undrawn, exactly as it was chosen for all four before
   * working landed.
   */
  describe('a worker, whose other loops have not been drawn', () => {
    it('idles through rest, having no sleep art', () => {
      expect(sheetsOf(dwarfClips('worker', true, false))).toEqual(sheetsOf([loopOf(WORKER.idle)]))
    })

    it('plays no transition it does not have, rather than substituting one', () => {
      // Every clip is a loop: a missing transition is DROPPED, never filled
      // with the idle, which would read as a stutter before every state.
      for (const [resting, was] of [
        [true, false],
        [false, true],
        [true, true],
        [false, false]
      ] as const) {
        const clips = dwarfClips('worker', resting, was)
        expect(
          clips.map((clip) => clip.playback),
          `${resting}/${was}`
        ).toEqual(['loop'])
      }
    })

    it('settles on a loop whatever it is doing, so it never freezes on a pose', () => {
      for (const role of ROLES) {
        for (const [resting, was] of [
          [true, false],
          [false, true],
          [true, true],
          [false, false]
        ] as const) {
          const clips = dwarfClips(role, resting, was)
          expect(clips[clips.length - 1]?.playback, `${role}/${resting}/${was}`).toBe('loop')
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
      for (const [resting, was] of [
        [true, false],
        [false, true]
      ] as const) {
        for (const clip of dwarfClips(role, resting, was)) {
          expect(otherSheets, `${role}/${resting}/${was}`).not.toContain(clip.sheet.src)
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
      for (const [resting, was] of [
        [true, false],
        [false, true],
        [true, true],
        [false, false]
      ] as const) {
        const clips = dwarfClips(role, resting, was)
        const held = stillFrameOf(clips)
        const sheet = clips[held.clip]?.sheet
        expect(sheet, `${role}/${resting}/${was}`).toBeDefined()
        expect(held.frame, `${role}/${resting}/${was}`).toBeLessThan(sheet!.frames)
      }
    }
  })
})

/*
 * What the panel can no longer tell apart, pinned so that it is a recorded
 * consequence and not a surprise. Silence (#47), rest (#34) and travel (#19)
 * each selected their own pose off the painted frames; none of them has been
 * drawn as a sheet, so all three now play the rank's idle. The information did
 * not vanish from the panel — the sleep marker still marks a resting dwarf and
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
      sheetsOf(dwarfClips('worker', isResting(status), false)).join()
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
