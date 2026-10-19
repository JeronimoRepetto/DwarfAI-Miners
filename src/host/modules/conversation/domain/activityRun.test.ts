// layer: L1
// L1 (17 §1.1): machine 11, the activity run (07 §11; 06 §9.2 `ActivityDisclosure`, INV-66). Pure:
// every instant and every new id is passed in. A run opens at the first tool step, grows on every
// further step, stays open through the person's own message, an ask and its "Answers:" record, and
// closes only when the dwarf speaks, its turn ends, its session ends or the Host lost it in a crash.
//
// TC-101-01 (at most one open run per dwarf; a closed run's stepCount equals its summaries).
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import {
  applyAnswerRecord,
  applyAskOpened,
  applyBootLost,
  applyDwarfSpoke,
  applyPersonMessage,
  applyReadopted,
  applySessionEnded,
  applyStep,
  applyTurnEnded,
  applyWindowClosed,
  machine11,
  MACHINE_11,
  type ActivityDisclosure,
  type ActivityTrigger,
  type RunChange
} from './activityRun'

const DWARF = '00000000-0000-7000-8000-0000000000d1' as DwarfId
const T0 = 1_790_000_000_000

/** A run's id source: `run-1`, `run-2`, … in the order runs open. */
function idSource(): () => string {
  let n = 0
  return () => `run-${(n += 1)}`
}

const step = (n: number) => ({
  sourceKey: `claude:claude:session-1:tool-${n}`,
  summary: `Ran step ${n}`,
  at: T0 + n
})

/** An open run of `steps` steps, opened through the machine itself. */
function openRun(steps: number, newId = idSource()): ActivityDisclosure {
  let run: ActivityDisclosure | null = null
  for (let n = 1; n <= steps; n += 1) run = applyStep(run, DWARF, step(n), newId).run
  if (run === null) throw new Error('no run opened')
  return run
}

describe('activity run (machine 11)', () => {
  it("[US-MSG-014.AC01, S11.02, INV-66] the person's message, delivered or failed, never closes an open run", () => {
    const run = openRun(2)

    // Delivered or failed, the person's own message is the same trigger for the run.
    for (const at of [T0 + 10, T0 + 20]) {
      const change = applyPersonMessage(run, at)
      expect(change).toEqual({ run, changed: false })
      expect(change.run?.open).toBe(true)
      expect(change.run?.closedAt).toBeUndefined()
    }
  })

  it('[US-MSG-014.AC02, US-ASK-006.AC03, S11.02] an ask arriving inside an open run keeps it open, and the next step after the answer grows the same run', () => {
    const newId = idSource()
    const run = openRun(1, newId)

    const asked = applyAskOpened(run)
    expect(asked).toEqual({ run, changed: false })
    const answered = applyAnswerRecord(asked.run)
    expect(answered).toEqual({ run, changed: false })

    // The answer seen acting: the next tool step grows the same run instead of a new one.
    const grown = applyStep(answered.run, DWARF, step(2), newId)
    expect(grown.changed).toBe(true)
    expect(grown.run).toMatchObject({ id: run.id, open: true, stepCount: 2 })
    expect(grown.run?.summaries).toEqual(['Ran step 1', 'Ran step 2'])
  })

  it("[US-MSG-014.AC05, S11.02] an Answers: record does not close the run; only the dwarf's own later action does", () => {
    const run = openRun(3)

    const answered = applyAnswerRecord(run)
    expect(answered.changed).toBe(false)
    expect(answered.run?.open).toBe(true)

    const spoke = applyDwarfSpoke(answered.run, T0 + 50)
    expect(spoke.changed).toBe(true)
    expect(spoke.run).toMatchObject({ id: run.id, open: false, closedAt: T0 + 50, stepCount: 3 })
  })

  it('[US-MSG-014.AC03, S11.03, S11.04, S11.05] the dwarf speaking, its turn ending or its session ending closes the run with its step count', () => {
    const closers: [string, (open: ActivityDisclosure | null, at: number) => RunChange][] = [
      ['the dwarf speaks', applyDwarfSpoke],
      ['its turn ends', applyTurnEnded],
      ['its session ends', applySessionEnded]
    ]
    for (const [name, close] of closers) {
      const run = openRun(4)
      const change = close(run, T0 + 99)
      expect(change.changed, name).toBe(true)
      expect(change.run, name).toEqual({
        ...run,
        open: false,
        stepCount: 4,
        closedAt: T0 + 99
      })
      // Closing again, or closing with no open run, changes nothing.
      expect(close(null, T0 + 100), name).toEqual({ run: null, changed: false })
    }
  })

  it('[US-MSG-014.AC04, INV-66] at most one run per dwarf is open at any time; a step after a close opens a new run', () => {
    const newId = idSource()
    // A seeded walk of every trigger: after each one, at most the current run is open, and every
    // run that closed stays closed.
    const triggers = ['step', 'person', 'ask', 'answer', 'spoke', 'turn', 'session'] as const
    let seed = 7
    const next = () => (seed = (seed * 48_271) % 2_147_483_647)
    let open: ActivityDisclosure | null = null
    const runs = new Map<string, ActivityDisclosure>()
    let n = 0
    for (let i = 0; i < 400; i += 1) {
      n += 1
      const at = T0 + n
      const trigger = triggers[next() % triggers.length]
      const change: RunChange =
        trigger === 'step'
          ? applyStep(open, DWARF, step(n), newId)
          : trigger === 'person'
            ? applyPersonMessage(open, at)
            : trigger === 'ask'
              ? applyAskOpened(open)
              : trigger === 'answer'
                ? applyAnswerRecord(open)
                : trigger === 'spoke'
                  ? applyDwarfSpoke(open, at)
                  : trigger === 'turn'
                    ? applyTurnEnded(open, at)
                    : applySessionEnded(open, at)
      if (change.run !== null) runs.set(change.run.id, change.run)
      open = change.run?.open === true ? change.run : null
      expect([...runs.values()].filter((run) => run.open).length).toBeLessThanOrEqual(1)
    }
    expect(runs.size).toBeGreaterThan(10)

    // A step after a close opens a new run, never the closed one again.
    const first = openRun(2, newId)
    const closed = applyDwarfSpoke(first, T0 + 1_000).run
    const reopened = applyStep(closed, DWARF, step(3), newId)
    expect(reopened.changed).toBe(true)
    expect(reopened.run).toMatchObject({ open: true, stepCount: 1, summaries: ['Ran step 3'] })
    expect(reopened.run?.id).not.toBe(first.id)
    expect(closed).toMatchObject({ id: first.id, open: false, stepCount: 2 })
  })

  it("[US-MSG-004.AC05] a closed run's stepCount equals the number of steps it holds", () => {
    for (const steps of [1, 2, 7, 50]) {
      const closed = applyTurnEnded(openRun(steps), T0 + 500).run
      expect(closed?.open).toBe(false)
      expect(closed?.stepCount).toBe(steps)
      expect(closed?.summaries).toHaveLength(steps)
    }
  })

  it('[S11.07] a window close and a re-adopted running turn change nothing', () => {
    const run = openRun(2)
    expect(applyWindowClosed(run)).toEqual({ run, changed: false })
    expect(applyReadopted(run)).toEqual({ run, changed: false })
    expect(machine11('open', 'window-closed')).toMatchObject({ id: 'S11.07', to: 'open' })
    expect(machine11('open', 'boot-readopted')).toMatchObject({ id: 'S11.07', to: 'open' })
  })

  it('[S11.01, S11.06] every machine 11 transition reaches its target: the first tool step opens a run with stepCount 1, and the boot close of an unrecovered or turn-lost dwarf closes it with the crash-time inferred end; a transition 07 does not list is rejected', () => {
    // The 07 §11 table, row by row.
    const listed: [string, 'none' | 'open', ActivityTrigger, 'open' | 'closed'][] = [
      ['S11.01', 'none', 'tool-step', 'open'],
      ['S11.02', 'open', 'tool-step', 'open'],
      ['S11.02', 'open', 'person-message', 'open'],
      ['S11.02', 'open', 'ask-opened', 'open'],
      ['S11.02', 'open', 'answer-record', 'open'],
      ['S11.03', 'open', 'dwarf-spoke', 'closed'],
      ['S11.04', 'open', 'turn-ended', 'closed'],
      ['S11.05', 'open', 'session-ended', 'closed'],
      ['S11.06', 'open', 'boot-lost', 'closed'],
      ['S11.07', 'open', 'boot-readopted', 'open'],
      ['S11.07', 'open', 'window-closed', 'open']
    ]
    expect(MACHINE_11.map((t) => [t.id, t.from, t.trigger, t.to])).toEqual(listed)
    for (const [id, from, trigger, to] of listed) {
      expect(machine11(from, trigger), `${id} ${trigger}`).toEqual({ id, from, trigger, to })
    }

    // S11.01: the first tool step opens a run of one step.
    const opened = applyStep(null, DWARF, step(1), idSource())
    expect(opened).toEqual({
      changed: true,
      run: {
        id: 'run-1',
        dwarfId: DWARF,
        turnKey: 'claude:claude:session-1:tool-1',
        open: true,
        stepCount: 1,
        summaries: ['Ran step 1'],
        openedAt: T0 + 1
      }
    })

    // S11.06: closed at the crash-time inferred end, with its steps kept.
    const lost = applyBootLost(openRun(3), T0 + 777)
    expect(lost.changed).toBe(true)
    expect(lost.run).toMatchObject({ open: false, closedAt: T0 + 777, stepCount: 3 })

    // Not listed by 07: nothing closes or grows with no open run, and a closed run never moves.
    const triggers = listed.map(([, , trigger]) => trigger)
    for (const trigger of triggers) {
      expect(machine11('closed', trigger), `closed ${trigger}`).toBeNull()
      if (trigger !== 'tool-step') {
        expect(machine11('none', trigger), `none ${trigger}`).toBeNull()
      }
    }
    expect(applyDwarfSpoke(null, T0)).toEqual({ run: null, changed: false })
    expect(applyBootLost(null, T0)).toEqual({ run: null, changed: false })
    expect(applyPersonMessage(null, T0)).toEqual({ run: null, changed: false })
  })
})
