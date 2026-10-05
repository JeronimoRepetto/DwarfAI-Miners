// The ActivityLog conformance suite (16 §4.6 `ActivityLog`; 16 §2.8; 17 §1.3): run on the in-memory
// double and on the SQLite adapter over `activity_disclosures` (09 §4.4). A run is saved, grows and
// closes in place under its id; the store refuses a second open run for a dwarf (INV-66,
// `activity_disclosures_one_open`); each save keeps the dwarf's newest 50 runs and never trims the
// open one (09 §5.2 step 4; ADR-007); every write runs inside the caller's transaction (16 §2.2).
// `openRun` (16 §4.6, amendment A): null with no run, the open run, null after it closes, and the
// same answer from a reopened store. `saveOutcome` (16 §4.6, ISSUE-102): one outcome line per dwarf
// over `outcome_lines`, replaced by the next save, the same line twice changing nothing, inside the
// caller's transaction (INV-67; 09 §4.4).
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, Instant } from '../../../kernel/domain/values'
import type { ActivityDisclosure } from '../domain/activityRun'
import type { OutcomeLine } from '../domain/outcomeLine'
import { ACTIVITY_RUNS_PER_DWARF } from '../domain/retention'
import type { ActivityLog } from '../ports/activityLog'

export interface ActivityLogSubject {
  log: ActivityLog
  /** Two dwarfs that exist in the subject's store (the SQLite half seeds their rows). */
  dwarfIds: readonly [DwarfId, DwarfId]
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  /** Every stored run of the dwarf, by `openedAt` then id. */
  runs(dwarfId: DwarfId): ActivityDisclosure[]
  /** The dwarf's stored outcome line, or null. */
  outcome(dwarfId: DwarfId): OutcomeLine | null
  /** A new store over the same stored runs: what a Host restart opens (S11.07). */
  reopen(): ActivityLog
  dispose(): void | Promise<void>
}

const T0 = 1_790_000_000_000

/** The n-th run of `dwarfId`: a UUIDv7-shaped id, opened at T0 + n. */
function run(
  dwarfId: DwarfId,
  n: number,
  overrides: Partial<ActivityDisclosure> = {}
): ActivityDisclosure {
  return {
    id: `00000000-0000-7000-8000-${dwarfId.slice(-2)}${String(n).padStart(10, '0')}`,
    dwarfId,
    turnKey: `claude:claude:session-1:tool-${n}`,
    open: false,
    stepCount: 1,
    summaries: [`Ran step ${n}`],
    openedAt: T0 + n,
    closedAt: (T0 + n + 1) as Instant,
    ...overrides
  }
}

/** An open run: no `closedAt`. */
function openRunOf(dwarfId: DwarfId, n: number, steps = 1): ActivityDisclosure {
  const { closedAt, ...rest } = run(dwarfId, n, {
    open: true,
    stepCount: steps,
    summaries: Array.from({ length: steps }, (_, i) => `Ran step ${n}.${i + 1}`)
  })
  void closedAt
  return rest
}

/** A working line with `n` steps so far. */
function workingLine(dwarfId: DwarfId, n: number): OutcomeLine {
  return {
    dwarfId,
    kind: 'working',
    stepCount: n,
    parts: [{ kind: 'steps-so-far', n }],
    reliability: 'reliable',
    at: T0 + n
  }
}

/** A finished line with every optional field and the most parts the rule makes. */
function finishedLine(dwarfId: DwarfId): OutcomeLine {
  return {
    dwarfId,
    kind: 'capped',
    stepCount: 5,
    parts: [
      { kind: 'steps', n: 5 },
      { kind: 'idle-since', at: T0 + 100 }
    ],
    detail: 'max_turns',
    closingWords: 'I stopped at the limit — “quoted” ✓',
    reliability: 'reliable',
    at: T0 + 100
  }
}

export function runActivityLogContract(
  makeSubject: () => ActivityLogSubject | Promise<ActivityLogSubject>
): void {
  describe('ActivityLog contract', () => {
    let subject: ActivityLogSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async () => {
      subject = await makeSubject()
      return subject
    }

    it("[S11.01, S11.02, S11.03] a run is saved, grows and closes in place under its id, and openRun answers only the dwarf's open run", async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds
      const opened = openRunOf(dwarf, 1)

      s.inTransaction(() => s.log.saveDisclosure(opened))
      expect(s.inTransaction(() => s.log.openRun(dwarf))).toEqual(opened)
      expect(s.inTransaction(() => s.log.openRun(other))).toBeNull()

      // It grows in place: the same id, the step count and summaries of the save.
      const grown = {
        ...opened,
        stepCount: 3,
        summaries: ['Ran pnpm test', 'Edited src/parse.ts', 'Searched “TODO” ✓']
      }
      s.inTransaction(() => s.log.saveDisclosure(grown))
      expect(s.runs(dwarf)).toEqual([grown])

      // It closes in place; the dwarf then has no open run.
      const closed = { ...grown, open: false, closedAt: T0 + 50 }
      s.inTransaction(() => s.log.saveDisclosure(closed))
      expect(s.runs(dwarf)).toEqual([closed])
      expect(s.inTransaction(() => s.log.openRun(dwarf))).toBeNull()
    })

    it('[S11.07, INV-66] openRun answers null with no run, the open run while it is open, null once it closed, and the same from a reopened store', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds
      expect(s.inTransaction(() => s.log.openRun(dwarf))).toBeNull()

      // An open run, with a closed one before it and another dwarf's open run beside it.
      const closedBefore = run(dwarf, 1)
      const open = openRunOf(dwarf, 2, 3)
      const theirs = openRunOf(other, 3)
      s.inTransaction(() => {
        s.log.saveDisclosure(closedBefore)
        s.log.saveDisclosure(open)
        s.log.saveDisclosure(theirs)
      })
      expect(s.inTransaction(() => s.log.openRun(dwarf))).toEqual(open)

      // A Host restart: the run is still open, read from the stored rows (S11.07).
      const reopened = s.reopen()
      expect(s.inTransaction(() => reopened.openRun(dwarf))).toEqual(open)
      expect(s.inTransaction(() => reopened.openRun(other))).toEqual(theirs)

      // Once it closes, the dwarf has no open run, before and after a restart.
      s.inTransaction(() => reopened.saveDisclosure({ ...open, open: false, closedAt: T0 + 90 }))
      expect(s.inTransaction(() => reopened.openRun(dwarf))).toBeNull()
      expect(s.inTransaction(() => s.reopen().openRun(dwarf))).toBeNull()
      // Outside the caller's transaction the read is refused (16 §2.2).
      expect(() => reopened.openRun(other)).toThrow(HostInvariantError)
    })

    it('[INV-66] a second open run for the same dwarf is refused by the store', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds
      const first = openRunOf(dwarf, 1)
      s.inTransaction(() => s.log.saveDisclosure(first))

      expect(() => s.inTransaction(() => s.log.saveDisclosure(openRunOf(dwarf, 2)))).toThrow()

      // The refused save left nothing; the first run is still the dwarf's only open run.
      expect(s.runs(dwarf)).toEqual([first])
      expect(s.inTransaction(() => s.log.openRun(dwarf))).toEqual(first)
      // Another dwarf has its own open run.
      const theirs = openRunOf(other, 3)
      s.inTransaction(() => s.log.saveDisclosure(theirs))
      expect(s.inTransaction(() => s.log.openRun(other))).toEqual(theirs)
      // Once the first closes, a new open run of the dwarf is accepted.
      s.inTransaction(() => {
        s.log.saveDisclosure({ ...first, open: false, closedAt: T0 + 10 })
        s.log.saveDisclosure(openRunOf(dwarf, 4))
      })
      expect(
        s
          .runs(dwarf)
          .filter((r) => r.open)
          .map((r) => r.id)
      ).toEqual([openRunOf(dwarf, 4).id])
    })

    it('[ADR-007] the newest 50 runs per dwarf are kept and the open one is never trimmed', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds
      expect(ACTIVITY_RUNS_PER_DWARF).toBe(50)
      // The open run is the oldest-opened run of the dwarf: the cap ranks it first all the same.
      const open = openRunOf(dwarf, 0)
      s.inTransaction(() => s.log.saveDisclosure(open))
      // Another dwarf's runs are never touched by this dwarf's cap.
      const theirs = Array.from({ length: 3 }, (_, n) => run(other, n + 1))
      s.inTransaction(() => theirs.forEach((r) => s.log.saveDisclosure(r)))

      for (let n = 1; n <= 60; n += 1) {
        s.inTransaction(() => s.log.saveDisclosure(run(dwarf, n)))
      }

      const kept = s.runs(dwarf)
      expect(kept).toHaveLength(ACTIVITY_RUNS_PER_DWARF)
      expect(kept[0]).toEqual(open)
      // The open run and the 49 newest closed runs: runs 12…60.
      expect(kept.slice(1).map((r) => r.openedAt)).toEqual(
        Array.from({ length: 49 }, (_, i) => T0 + 12 + i)
      )
      expect(s.runs(other)).toEqual(theirs)
    })

    it('[INV-67] saveOutcome keeps one outcome line per dwarf: a later save replaces it, the same line twice changes nothing, and another dwarf keeps its own', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds
      expect(s.outcome(dwarf)).toBeNull()

      s.inTransaction(() => s.log.saveOutcome(workingLine(dwarf, 1)))
      expect(s.outcome(dwarf)).toEqual(workingLine(dwarf, 1))

      // Replaced at every turn change: every field, the optional ones included.
      s.inTransaction(() => s.log.saveOutcome(finishedLine(dwarf)))
      expect(s.outcome(dwarf)).toEqual(finishedLine(dwarf))
      // The same line again changes nothing.
      s.inTransaction(() => s.log.saveOutcome(finishedLine(dwarf)))
      expect(s.outcome(dwarf)).toEqual(finishedLine(dwarf))

      // A line without the optional fields clears them; another dwarf's line is its own.
      s.inTransaction(() => {
        s.log.saveOutcome(workingLine(dwarf, 2))
        s.log.saveOutcome({ ...workingLine(other, 0), parts: [] })
      })
      expect(s.outcome(dwarf)).toEqual(workingLine(dwarf, 2))
      expect(s.outcome(other)).toEqual({ ...workingLine(other, 0), parts: [] })
    })

    it("[INV-67] saveOutcome outside the caller's transaction throws HostInvariantError, and a rolled-back save leaves the previous line", async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds

      expect(() => s.log.saveOutcome(workingLine(dwarf, 1))).toThrow(HostInvariantError)
      expect(s.outcome(dwarf)).toBeNull()

      s.inTransaction(() => s.log.saveOutcome(workingLine(dwarf, 1)))
      expect(() =>
        s.inTransaction(() => {
          s.log.saveOutcome(finishedLine(dwarf))
          throw new Error('the batch failed')
        })
      ).toThrow('the batch failed')
      expect(s.outcome(dwarf)).toEqual(workingLine(dwarf, 1))
    })

    it("[ADR-007] saveDisclosure outside the caller's transaction throws HostInvariantError and stores nothing", async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds

      expect(() => s.log.saveDisclosure(openRunOf(dwarf, 1))).toThrow(HostInvariantError)
      expect(s.runs(dwarf)).toEqual([])
    })
  })
}
