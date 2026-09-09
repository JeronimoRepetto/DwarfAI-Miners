import { describe, expect, it } from 'vitest'
import type { DwarfRole, DwarfStatus } from '../../types'
import { DWARF_SHEETS } from './dwarfSheets'
import { dwarfClips, isResting, stillFrameOf } from './dwarfSequence'
import { isImpactFrame, loopOf, onceOf, sequenceFrameAt } from './spriteSheet'

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
    /*
     * AMENDED for #325, three cases in this block. They pinned the sequence
     * #74 shipped — the pick "picked up once, then swings on", `[once
     * start-working, loop working]` — which is the behaviour the maintainer
     * watched for more than a few seconds and could not read. Work is a SHIFT
     * CYCLE now (see the block that pins it below), so a worker at the rock
     * plays the same four clips whichever way it arrived there. What each case
     * was really guaranteeing survives, restated against the cycle:
     *
     * - 'picks up the pick once, then swings on' becomes 'picks the pick up
     *   and swings twice' — the entry still opens on the pick-up.
     * - 'does not pick the tool back up while it is still swinging it' becomes
     *   'plays the same cycle whether or not it was already working' — the
     *   non-replay guarantee, which the cycle keeps by being the sequence for
     *   both working states rather than by having no pick-up in it. Nothing
     *   restarts: `DwarfSprite.vue` recomputes clips only when one of the
     *   states it watches actually changes.
     * - 'starts working on a first render that already finds it working' keeps
     *   its name and its reasoning; only the expected clips change.
     *
     * 'sets the pick down once, then goes back to idling' is untouched: the
     * way OUT of work is unchanged by #325.
     */
    it('picks the pick up and swings twice, which is one turn of the shift', () => {
      expect(sheetsOf(dwarfClips('worker', false, false, true, false))).toEqual(
        sheetsOf([
          loopOf(WORKER['start-working']!),
          loopOf(WORKER.working!),
          loopOf(WORKER.working!),
          loopOf(WORKER['end-working']!)
        ])
      )
    })

    it('sets the pick down once, then goes back to idling', () => {
      expect(sheetsOf(dwarfClips('worker', false, false, false, true))).toEqual(
        sheetsOf([onceOf(WORKER['end-working']!), loopOf(WORKER.idle)])
      )
    })

    it('plays the same cycle whether or not it was already working', () => {
      // Same non-replay guarantee as the foreman's sleep, kept in the shape
      // the cycle needs: the sequence is a pure function of the two working
      // states, so recomputing mid-shift cannot restart anything.
      expect(sheetsOf(dwarfClips('worker', false, false, true, true))).toEqual(
        sheetsOf(dwarfClips('worker', false, false, true, false))
      )
    })

    it('starts working on a first render that already finds it working', () => {
      // A worker spawned already at the rock has nothing to interrupt, and the
      // pick-up is what makes the start legible rather than a worker spawned
      // mid-swing — the same reasoning as the foreman falling asleep on a
      // first render that already finds him asked.
      expect(sheetsOf(dwarfClips('worker', false, undefined, true, undefined))).toEqual(
        sheetsOf(dwarfClips('worker', false, false, true, false))
      )
      expect(sheetsOf(dwarfClips('worker', false, undefined, true, undefined))[0]).toBe(
        `loop:${WORKER['start-working']!.src}`
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

    // AMENDED for #325: the expected entry was `[once start-working, loop
    // working]`, #74's sequence. It is the shift cycle now; the CLAIM — that
    // arriving already working and starting work while standing are the same
    // starting line — is what this case is for and is untouched.
    it('starts the working sequence on arrival, the same entry as a dwarf that was already standing', () => {
      const onArrival = dwarfClips('worker', false, false, true, false, true)
      expect(sheetsOf(onArrival)).toEqual(
        sheetsOf([
          loopOf(WORKER['start-working']!),
          loopOf(WORKER.working!),
          loopOf(WORKER.working!),
          loopOf(WORKER['end-working']!)
        ])
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
      // AMENDED for #325 alongside the worker's own entry above, and for the
      // same reason: what is pinned here is the GATE, not which clips are
      // behind it.
      expect(sheetsOf(dwarfClips('worker2', false, false, true, false, true))).toEqual(
        sheetsOf([
          loopOf(WORKER2['start-working']!),
          loopOf(WORKER2.working!),
          loopOf(WORKER2.working!),
          loopOf(WORKER2['end-working']!)
        ])
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
   * Issue #325 — work is a SHIFT, not an endless swing.
   *
   * Seen live for the first time on 2026-09-09: watched for more than a few
   * seconds, a pick swinging for ever stopped reading as a dwarf working at
   * all. The sequence a dwarf at the rock plays is now the cycle `start-working
   * -> working -> working -> end-working`, round and round for as long as the
   * status holds — a movement with a beginning and an end, which says "still
   * working" again every three to five seconds instead of once.
   *
   * The cycle is the SETTLED state, which is why all four clips are loops: a
   * `loop` clip says "part of what this sequence settles into", and a run of
   * them is one cycle (see `sequenceCycle` in spriteSheet.ts). The exit is
   * untouched and is pinned in the block above — leaving work plays
   * end-working ONCE and idles.
   */
  describe('work is a shift cycle (#325)', () => {
    /** The cycle a rank plays at the rock, in order, so a failure names the art. */
    function cycleOf(role: 'worker' | 'worker2'): string[] {
      const sheets = DWARF_SHEETS[role]
      return sheetsOf([
        loopOf(sheets['start-working']!),
        loopOf(sheets.working!),
        loopOf(sheets.working!),
        loopOf(sheets['end-working']!)
      ])
    }

    it('picks the pick up, swings twice, sets it down and starts again', () => {
      for (const role of ['worker', 'worker2'] as const) {
        expect(sheetsOf(dwarfClips(role, false, false, true, false)), role).toEqual(cycleOf(role))
      }
    })

    it('is the same cycle for a dwarf that was already working, having nothing to interrupt', () => {
      // Both entry cases produce one sequence, which is what the interruption
      // rule at the top of dwarfSequence.ts requires of every axis: the clips
      // are a pure function of the two working states and of nothing else.
      for (const role of ['worker', 'worker2'] as const) {
        expect(sheetsOf(dwarfClips(role, false, false, true, true)), role).toEqual(cycleOf(role))
        expect(sheetsOf(dwarfClips(role, false, undefined, true, undefined)), role).toEqual(
          cycleOf(role)
        )
      }
    })

    it('runs the worker through 35 frames of shift before the pick comes up again', () => {
      // 3 + 13 + 13 + 6 = 35 frames at 100ms, so 3.5s a turn. Read off the
      // sheets rather than written down, because the counts belong to the art.
      const clips = dwarfClips('worker', false, false, true, false)
      const start = WORKER['start-working']!.frames * 100
      const swing = WORKER.working!.frames * 100
      const end = WORKER['end-working']!.frames * 100
      expect(start + swing + swing + end).toBe(3500)

      expect(sequenceFrameAt(clips, 0)).toEqual({ clip: 0, frame: 0 })
      expect(sequenceFrameAt(clips, start)).toEqual({ clip: 1, frame: 0 })
      expect(sequenceFrameAt(clips, start + swing)).toEqual({ clip: 2, frame: 0 })
      expect(sequenceFrameAt(clips, start + swing + swing)).toEqual({ clip: 3, frame: 0 })
      // The set-down's last frame, and then the pick-up again: the cycle
      // closing is the whole point of it.
      expect(sequenceFrameAt(clips, start + swing + swing + end - 100)).toEqual({
        clip: 3,
        frame: WORKER['end-working']!.frames - 1
      })
      expect(sequenceFrameAt(clips, start + swing + swing + end)).toEqual({ clip: 0, frame: 0 })
    })

    it('runs worker2 through its own 53, the art being longer at both ends', () => {
      // 16 + 10 + 10 + 17 = 53 frames, 5.3s a turn. A slower pick-up and a
      // set-down nearly three times the worker's — that is the art (#211).
      const clips = dwarfClips('worker2', false, false, true, false)
      const start = WORKER2['start-working']!.frames * 100
      const swing = WORKER2.working!.frames * 100
      const end = WORKER2['end-working']!.frames * 100
      expect(start + swing + swing + end).toBe(5300)
      expect(sequenceFrameAt(clips, start + swing + swing + end)).toEqual({ clip: 0, frame: 0 })
      expect(sequenceFrameAt(clips, start + swing)).toEqual({ clip: 2, frame: 0 })
    })

    it('bites the rock on both turns of the swing, not only the first', () => {
      // The sparks and the strike glow are the sheet's own claim about a frame
      // (`impactFrames`), and the second turn draws the same sheet — so a hit
      // lands on every lap exactly as it did when the swing looped alone.
      const clips = dwarfClips('worker', false, false, true, false)
      const start = WORKER['start-working']!.frames * 100
      const swing = WORKER.working!.frames * 100
      const hit = WORKER.working!.impactFrames![0]! * 100
      const turns = [start + hit, start + swing + hit].map((elapsed) => {
        const at = sequenceFrameAt(clips, elapsed)
        const sheet = clips[at.clip]?.sheet
        expect(sheet?.src, String(elapsed)).toBe(WORKER.working!.src)
        expect(isImpactFrame(sheet!, at.frame), String(elapsed)).toBe(true)
        return at.clip
      })
      // Two turns of the same sheet, drawn from two clips of the cycle rather
      // than from one clip going round twice — which is what makes the
      // set-down behind them reachable at all.
      expect(turns).toEqual([1, 2])
    })

    it('never reaches an idle behind the cycle, because the shift never runs out', () => {
      // The exit is a change of STATE, not something the sequence plays its
      // way into — which is why no idle is appended to the cycle at all.
      const clips = dwarfClips('worker', false, false, true, false)
      expect(clips.map((clip) => clip.sheet.src)).not.toContain(WORKER.idle.src)
      expect(sequenceFrameAt(clips, 600_000).clip).toBeLessThan(clips.length)
    })

    it('leaves work the same way it always did, set the pick down once and idle', () => {
      // Stated inside this block as well as above, because "the exit is
      // unchanged" is a claim OF #325 and not merely an untouched neighbour:
      // the set-down on the way out is a `once` clip, plays one time and hands
      // over to the idle — it is not the cycle's own end-working going round.
      for (const role of ['worker', 'worker2'] as const) {
        const sheets = DWARF_SHEETS[role]
        expect(sheetsOf(dwarfClips(role, false, false, false, true)), role).toEqual(
          sheetsOf([onceOf(sheets['end-working']!), loopOf(sheets.idle)])
        )
      }
    })

    it('leaves the foreman on his idle, having no working art to make a shift of', () => {
      // A cycle built out of the fallback idle would be the same six frames
      // twice over, which is not a shift — it is the idle with a seam in it.
      for (const wasWorking of [false, true, undefined]) {
        expect(
          sheetsOf(dwarfClips('foreman', false, false, true, wasWorking)),
          `${wasWorking}`
        ).toEqual(sheetsOf([loopOf(FOREMAN.idle)]))
      }
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
    //
    // UNCHANGED by #325, and deliberately so — the swing is still the second
    // clip of what a working dwarf plays, and it is still the frame held. The
    // block below is what pins WHY that is no longer the last clip.
    const midWork = dwarfClips('worker', false, false, true, false)
    expect(stillFrameOf(midWork)).toEqual({ clip: 1, frame: WORKER.working!.frames - 1 })

    const afterLeaving = dwarfClips('worker', false, false, false, true)
    expect(stillFrameOf(afterLeaving)).toEqual({ clip: 1, frame: WORKER.idle.frames - 1 })
  })

  /*
   * Reduced motion against a cycle (#325). The old rule — hold the LAST clip —
   * would now hold the last frame of end-working: a dwarf standing over a pick
   * on the ground, which says "stopped", not "working". The clip held is the
   * one the cycle REPEATS, because the strip a shift plays twice is the work
   * itself while the clips either side of it are only the way in and the way
   * out of it. Within that clip the frame is the last one, exactly as it has
   * always been for every other sequence.
   */
  describe('a still frame of a shift cycle (#325)', () => {
    it('holds the swing, never the pick lying on the ground', () => {
      for (const role of ['worker', 'worker2'] as const) {
        const sheets = DWARF_SHEETS[role]
        const cycle = dwarfClips(role, false, false, true, false)
        const held = stillFrameOf(cycle)
        expect(cycle[held.clip]?.sheet.src, role).toBe(sheets.working!.src)
        expect(held, role).toEqual({ clip: 1, frame: sheets.working!.frames - 1 })
        // The clip it is NOT: the set-down that closes the cycle.
        expect(held.clip, role).not.toBe(cycle.length - 1)
      }
    })

    it('holds the same frame whichever way the dwarf came to be working', () => {
      const entering = stillFrameOf(dwarfClips('worker', false, false, true, false))
      expect(stillFrameOf(dwarfClips('worker', false, false, true, true))).toEqual(entering)
    })

    it('still holds the last clip of a sequence that settles on one clip', () => {
      // Every sequence written before the cycle is unmoved: a lone loop, and a
      // transition handing over to one, both hold what they always held.
      expect(stillFrameOf(dwarfClips('foreman', true, false))).toEqual({
        clip: 1,
        frame: FOREMAN.sleeping!.frames - 1
      })
      expect(stillFrameOf(dwarfClips('foreman', false, false))).toEqual({
        clip: 0,
        frame: FOREMAN.idle.frames - 1
      })
    })
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
