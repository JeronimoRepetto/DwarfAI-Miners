// The conversation Reset step conformance suite (16 §4.12 `ResetDbStep`; 16 §2.8; 17 §1.3): run on
// the in-memory doubles and on the SQLite step over the template database. The seeded probe is the
// 09 §6.5 "Reset scope" probe for the conversation tables: two live dwarfs with provider messages,
// a delivered "Answers:" record, a closed and an open activity run and an outcome line each, and,
// for the first, a person message and an "Answers:" record whose deliveries are still `sending`.
// The step, run in the saga's `db` transaction, deletes every message, "Answers:" record,
// activity run and outcome line of every dwarf, live ones included, except a message whose
// delivery is still `sending`, which keeps its delivery (09 §7.2; ADR-023 items 1, 3, 4; S7.19);
// it leaves every `message_keys` row, so a replay re-inserts nothing older than the reset
// (INV-61, OQ-32 A); called outside a transaction it throws and writes nothing (16 §2.2).
//
// TC-107-01, TC-107-02.
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, Instant, MessageId } from '../../../kernel/domain/values'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { ConversationEntry } from '../../suppliers'
import type { ActivityDisclosure } from '../domain/activityRun'
import type { OutcomeLine } from '../domain/outcomeLine'
import type { ActivityLog } from '../ports/activityLog'
import type { MessageLog } from '../ports/messageLog'

export interface ConversationResetStepSubject {
  /** The step under test: the `ResetDbStep` shape (16 §4.12). */
  step: { readonly name: string; reset(tx: TransactionRunner): void }
  /** The saga's `db` transaction: commits when `work` returns, rolls back when it throws. */
  transactions: TransactionRunner
  log: MessageLog
  activity: ActivityLog
  /** Two live dwarfs that exist in the subject's store (the SQLite half seeds their rows). */
  dwarfIds: readonly [DwarfId, DwarfId]
  /** A DwarfAI-sent person row of `dwarfId` whose delivery is `sending`. */
  seedSendingRow(dwarfId: DwarfId, text: string): MessageId
  /** An "Answers:" record of `dwarfId` whose delivery is in `phase`. */
  seedAnswersRecord(dwarfId: DwarfId, text: string, phase: 'sending' | 'delivered'): MessageId
  /** The claimed key, with the row it points at, or null when the key was never seen. */
  keyOf(sourceKey: string): { dwarfId: DwarfId; messageId: MessageId | null } | null
  /** Every stored activity run of the dwarf, closed ones included. */
  runs(dwarfId: DwarfId): ActivityDisclosure[]
  dispose(): void | Promise<void>
}

const T0 = 1_790_000_000_000

/** The provider entries of `dwarfId`'s transcript: one per provider role. */
function transcript(dwarfId: DwarfId): ConversationEntry[] {
  return (['person', 'dwarf', 'system-line'] as const).map((role, n) => ({
    sourceKey: `claude:claude:session-${dwarfId.slice(-2)}:event-${n}`,
    role,
    text: `${role} line ${n}`,
    providerTime: (T0 + n) as Instant
  }))
}

/** The n-th run of `dwarfId`: a UUIDv7-shaped id, closed unless `open`. */
function run(dwarfId: DwarfId, n: number, open: boolean): ActivityDisclosure {
  return {
    id: `00000000-0000-7000-8000-${dwarfId.slice(-2)}${String(n).padStart(10, '0')}`,
    dwarfId,
    turnKey: `claude:claude:session-${dwarfId.slice(-2)}:turn-${n}`,
    open,
    stepCount: 1,
    summaries: [`Ran step ${n}`],
    openedAt: T0 + n,
    ...(open ? {} : { closedAt: (T0 + n + 1) as Instant })
  }
}

function workingLine(dwarfId: DwarfId): OutcomeLine {
  return {
    dwarfId,
    kind: 'working',
    stepCount: 1,
    parts: [{ kind: 'steps-so-far', n: 1 }],
    reliability: 'reliable',
    at: T0 + 5
  }
}

/** What the step must leave of a dwarf: its stored rows with their delivery phase, runs and line. */
interface DwarfState {
  rows: { id: MessageId; role: string; phase: string | null }[]
  runs: string[]
  openRun: string | null
  outcome: OutcomeLine | null
}

export function runConversationResetStepContract(
  makeSubject: () => ConversationResetStepSubject | Promise<ConversationResetStepSubject>
): void {
  describe('conversation ResetDbStep contract', () => {
    let subject: ConversationResetStepSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    /** The seeded probe; returns the first dwarf's two `sending` rows. */
    const seeded = async () => {
      const s = await makeSubject()
      subject = s
      for (const dwarfId of s.dwarfIds) {
        s.transactions.inTransaction(() => {
          s.log.append(dwarfId, transcript(dwarfId), 'transcript')
          s.activity.saveDisclosure(run(dwarfId, 1, false))
          s.activity.saveDisclosure(run(dwarfId, 2, true))
          s.activity.saveOutcome(workingLine(dwarfId))
        })
        s.seedAnswersRecord(dwarfId, 'Answers: yes', 'delivered')
      }
      const [first] = s.dwarfIds
      const sending = {
        person: s.seedSendingRow(first, 'please also run the tests'),
        answers: s.seedAnswersRecord(first, 'Answers: allow', 'sending')
      }
      return { s, sending }
    }

    const stateOf = (s: ConversationResetStepSubject, dwarfId: DwarfId): DwarfState =>
      s.transactions.inTransaction(() => ({
        rows: s.log
          .page(dwarfId, {})
          .map((m) => ({ id: m.id, role: m.role, phase: m.delivery?.phase ?? null }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        runs: s.runs(dwarfId).map((r) => r.id),
        openRun: s.activity.openRun(dwarfId)?.id ?? null,
        outcome: s.activity.outcomeOf(dwarfId)
      }))

    const sendingRows = (sending: { person: MessageId; answers: MessageId }) =>
      [
        { id: sending.person, role: 'person', phase: 'sending' },
        { id: sending.answers, role: 'answers-record', phase: 'sending' }
      ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    it('[ADR-023] the conversation step deletes every message, activity run and outcome line of every dwarf, live ones included', async () => {
      const { s } = await seeded()
      const [, second] = s.dwarfIds

      s.transactions.inTransaction(() => s.step.reset(s.transactions))

      expect(s.step.name).toBe('conversation')
      // The second dwarf is live (its session keeps running) and had nothing in flight.
      expect(stateOf(s, second)).toStrictEqual({ rows: [], runs: [], openRun: null, outcome: null })
      const first = stateOf(s, s.dwarfIds[0])
      expect(first.rows.filter((r) => r.phase !== 'sending')).toStrictEqual([])
      expect({ runs: first.runs, openRun: first.openRun, outcome: first.outcome }).toStrictEqual({
        runs: [],
        openRun: null,
        outcome: null
      })
    })

    it('[ADR-023] a message whose delivery is still sending and its delivery row survive the step', async () => {
      const { s, sending } = await seeded()
      const [first] = s.dwarfIds

      s.transactions.inTransaction(() => s.step.reset(s.transactions))

      expect(stateOf(s, first).rows).toStrictEqual(sendingRows(sending))
    })

    it('[ADR-023, INV-61] message_keys survive, so a replay after the reset re-inserts nothing older than the reset', async () => {
      const { s, sending } = await seeded()

      s.transactions.inTransaction(() => s.step.reset(s.transactions))
      const replayed = s.dwarfIds.map((dwarfId) =>
        s.transactions.inTransaction(() => s.log.append(dwarfId, transcript(dwarfId), 'transcript'))
      )

      expect(replayed).toStrictEqual([
        { inserted: 0, appended: [] },
        { inserted: 0, appended: [] }
      ])
      for (const dwarfId of s.dwarfIds) {
        for (const entry of transcript(dwarfId)) {
          expect(s.keyOf(entry.sourceKey)).toStrictEqual({ dwarfId, messageId: null })
        }
      }
      expect(stateOf(s, s.dwarfIds[0]).rows).toStrictEqual(sendingRows(sending))
      expect(stateOf(s, s.dwarfIds[1]).rows).toStrictEqual([])
    })

    it('[ADR-023] the step called with no open transaction throws and writes nothing', async () => {
      const { s } = await seeded()
      const before = s.dwarfIds.map((dwarfId) => stateOf(s, dwarfId))

      expect(() => s.step.reset(s.transactions)).toThrow(HostInvariantError)

      expect(s.dwarfIds.map((dwarfId) => stateOf(s, dwarfId))).toStrictEqual(before)
      expect(before[1]?.rows).toHaveLength(4)
    })
  })
}
