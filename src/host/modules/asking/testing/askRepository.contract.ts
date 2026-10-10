// The AskRepository conformance suite (16 §4.7 doubles row: "settle idempotent,
// `asks_one_answering`"; 17 §1.3): run on `InMemoryAskRepository` and on `SqliteAskRepository`
// over the template database. An ask saved by one repository is read back by a new repository over
// the same storage, as after a Host restart, with its payload and current step and nothing picked
// on earlier steps (ADR-010 item 9, INV-75, OQ-03). Never imported by production code (R14).
// Owner amendment K (2026-10-09, ISSUE-128): the `ask_answers` reads and writes of the answer paths
// (ADR-010 items 4, 5, 13; 09 §8.2; INV-79) — `byId`, `answerOf`, `recordOf`, `linkRecord`,
// `settleAnswer`.
import { afterEach, describe, expect, it } from 'vitest'
import type { AskId, DwarfId, MessageId } from '../../../kernel/domain/values'
import type { Ask } from '../domain/ask'
import type { AskRepository } from '../ports/askRepository'

export interface AskRepositorySubject {
  repository: AskRepository
  /** Two dwarfs the subject's storage knows (the SQLite rows reference `dwarfs`). */
  dwarfs: readonly [DwarfId, DwarfId]
  /** The caller's transaction (16 §2.2): commits when `work` returns. */
  inTransaction<T>(work: () => T): T
  /** A new repository over the same storage: what the next Host boot opens. */
  reopen(): AskRepository
  /** An "Answers:" record of the ask that `ask_answers.message_id` can name (the SQLite half seeds the row). */
  seedRecord(dwarfId: DwarfId, askId: AskId): MessageId
  dispose(): void | Promise<void>
}

const T0 = 1_790_000_000_000

/** An ask id: the `asks.id` CHECK wants 36 characters (09 §4.5). */
export function askId(n: number): AskId {
  return `00000000-0000-7000-8000-${String(n).padStart(12, '0')}` as AskId
}

/** A question of `dwarfId` with three steps, open on its first step. */
export function questionAsk(n: number, dwarfId: DwarfId, overrides: Partial<Ask> = {}): Ask {
  return {
    id: askId(n),
    dwarfId,
    kind: 'question',
    channel: 'driver',
    providerRequestId: `request-${n}`,
    payload: {
      steps: [
        { text: 'Which files?', options: ['All', 'Some'], allowsFreeText: true },
        { text: 'Run the tests?', options: ['Yes', 'No'], allowsFreeText: true },
        { text: 'Commit now?', options: ['Yes', 'No'], allowsFreeText: true }
      ]
    },
    currentStep: 0,
    state: 'open',
    reannounce: true,
    openedAt: T0 + n,
    ...overrides
  }
}

/** A permission request of `dwarfId`, open. */
export function permissionAsk(n: number, dwarfId: DwarfId, overrides: Partial<Ask> = {}): Ask {
  return {
    id: askId(n),
    dwarfId,
    kind: 'permission',
    channel: 'driver',
    providerRequestId: `request-${n}`,
    payload: { toolName: 'Bash', requestText: 'Run pnpm test' },
    currentStep: 0,
    state: 'open',
    reannounce: true,
    openedAt: T0 + n,
    ...overrides
  }
}

export function runAskRepositoryContract(
  makeSubject: () => AskRepositorySubject | Promise<AskRepositorySubject>
): void {
  describe('AskRepository contract', () => {
    let subject: AskRepositorySubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async (): Promise<AskRepositorySubject> => {
      subject = await makeSubject()
      return subject
    }

    it('[INV-72] settle on an open ask returns settled once and already-settled for the second call', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfs
      const ask = permissionAsk(1, dwarf)
      s.inTransaction(() => s.repository.save(ask))

      const first = s.inTransaction(() =>
        s.repository.settle(ask.id as AskId, { requestId: 'r-1' })
      )
      const second = s.inTransaction(() =>
        s.repository.settle(ask.id as AskId, { requestId: 'r-2' })
      )

      expect([first, second]).toStrictEqual(['settled', 'already-settled'])
      expect(s.repository.openFor(dwarf)).toStrictEqual({ ...ask, state: 'answering' })
      expect(s.reopen().openFor(dwarf)).toStrictEqual({ ...ask, state: 'answering' })
    })

    it('[INV-72] settle on an ask that is not open writes nothing and returns already-settled', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfs
      const closed = permissionAsk(2, dwarf, { state: 'cancelled', closedAt: T0 + 50 })
      s.inTransaction(() => s.repository.save(closed))

      const outcome = s.inTransaction(() =>
        s.repository.settle(closed.id as AskId, { requestId: 'r-3' })
      )

      expect(outcome).toBe('already-settled')
      expect(s.reopen().byProviderRequest({ dwarfId: dwarf }, 'request-2')).toStrictEqual(closed)
    })

    it('[INV-71] saving the same (dwarfId, providerRequestId) twice keeps one ask', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfs
      const ask = questionAsk(3, dwarf)
      const stepped = { ...ask, currentStep: 1 }

      s.inTransaction(() => s.repository.save(ask))
      s.inTransaction(() => s.repository.save(stepped))

      expect(s.repository.byProviderRequest({ dwarfId: dwarf }, 'request-3')).toStrictEqual(stepped)
      // Another id on the same key is refused, and the stored ask is unchanged (09 UNIQUE).
      expect(() =>
        s.inTransaction(() => s.repository.save({ ...ask, id: askId(30), currentStep: 2 }))
      ).toThrow()
      expect(s.reopen().byProviderRequest({ dwarfId: dwarf }, 'request-3')).toStrictEqual(stepped)
    })

    it('[INV-71] an ask is found by its dwarf and provider request in any state, and not by another dwarf', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfs
      const answered = permissionAsk(4, dwarf, { state: 'answered-in-app', closedAt: T0 + 9 })
      s.inTransaction(() => s.repository.save(answered))

      expect(s.repository.byProviderRequest({ dwarfId: dwarf }, 'request-4')).toStrictEqual(
        answered
      )
      expect(s.repository.byProviderRequest({ dwarfId: other }, 'request-4')).toBeNull()
      expect(s.repository.byProviderRequest({ dwarfId: dwarf }, 'request-unknown')).toBeNull()
    })

    it('[US-ASK-006.AC08, US-RES-003.AC02, INV-75] an open ask read back after the repository is reopened has its payload and current step and no picks of earlier steps', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfs
      const ask = questionAsk(5, dwarf)
      s.inTransaction(() => s.repository.save(ask))
      // The person walked to step 2 and picked options on steps 0 and 1; the picks belong to the
      // UI session store (OQ-03), so an ask carrying them by mistake must not store them.
      const withPicks = { ...ask, currentStep: 2, picks: [{ step: 0, option: 'All' }] } as Ask
      s.inTransaction(() => s.repository.save(withPicks))

      const reread = s.reopen().openFor(dwarf)

      expect(reread).toStrictEqual({ ...ask, currentStep: 2 })
      expect(Object.keys(reread ?? {}).sort()).toStrictEqual(
        [
          'channel',
          'currentStep',
          'dwarfId',
          'id',
          'kind',
          'openedAt',
          'payload',
          'providerRequestId',
          'reannounce',
          'state'
        ].sort()
      )
    })

    it("[US-RES-003.AC09, S6.01] an ask saved while no window is attached is read back as the dwarf's open ask", async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfs
      const front = permissionAsk(6, dwarf)
      const queued = questionAsk(7, dwarf)
      const otherDwarfs = permissionAsk(8, other)
      const closedEarlier = permissionAsk(1, dwarf, { state: 'cancelled', closedAt: T0 + 2 })
      s.inTransaction(() => {
        s.repository.save(closedEarlier)
        s.repository.save(queued)
        s.repository.save(front)
        s.repository.save(otherDwarfs)
      })

      const reopened = s.reopen()

      // The front ask is the oldest live one of the dwarf (ADR-010 item 7 FIFO), whoever saved it.
      expect(reopened.openFor(dwarf)).toStrictEqual(front)
      expect(reopened.openFor(other)).toStrictEqual(otherDwarfs)
    })

    it('[S6.01] a dwarf whose asks all closed has no open ask, while another dwarf keeps its own', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfs
      const ask = permissionAsk(9, dwarf)
      const othersAsk = questionAsk(10, other, { currentStep: 1 })
      s.inTransaction(() => {
        s.repository.save(ask)
        s.repository.save(othersAsk)
      })
      s.inTransaction(() =>
        s.repository.save({ ...ask, state: 'closed-by-death', closedAt: T0 + 20 })
      )

      expect(s.repository.openFor(dwarf)).toBeNull()
      expect(s.reopen().openFor(other)).toStrictEqual(othersAsk)
    })
    // ---------- owner amendment K (2026-10-09): the ask_answers reads and writes ----------

    it('[ADR-010] byId reads an ask in any state, and null for an unknown id', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfs
      const open = permissionAsk(11, dwarf)
      const closed = questionAsk(12, dwarf, { state: 'cancelled', closedAt: T0 + 5 })
      s.inTransaction(() => {
        s.repository.save(open)
        s.repository.save(closed)
      })

      expect(s.repository.byId(open.id as AskId)).toStrictEqual(open)
      expect(s.reopen().byId(closed.id as AskId)).toStrictEqual(closed)
      expect(s.repository.byId(askId(99))).toBeNull()
    })

    it('[INV-79] answerOf finds the winning requestId with its ask and no outcome until settleAnswer records it; a losing or unknown requestId finds nothing', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfs
      const ask = permissionAsk(13, dwarf)
      s.inTransaction(() => s.repository.save(ask))
      const id = ask.id as AskId

      s.inTransaction(() => s.repository.settle(id, { requestId: 'r-win' }))
      s.inTransaction(() => s.repository.settle(id, { requestId: 'r-lose' }))

      expect(s.repository.answerOf('r-win')).toStrictEqual({
        askId: id,
        outcome: null,
        messageId: null
      })
      expect(s.repository.answerOf('r-lose')).toBeNull()
      expect(s.repository.answerOf('r-unknown')).toBeNull()

      const record = s.seedRecord(dwarf, id)
      s.inTransaction(() => {
        s.repository.linkRecord('r-win', record)
        s.repository.settleAnswer('r-win', { kind: 'accepted' })
      })

      // The first result survives a Host restart (ask_answers PK = requestId, 14 §1.6).
      expect(s.reopen().answerOf('r-win')).toStrictEqual({
        askId: id,
        outcome: { kind: 'accepted' },
        messageId: record
      })
    })

    it('[ADR-010] settleAnswer records refused with its reason, and a second settleAnswer of the same request is refused', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfs
      const ask = questionAsk(14, dwarf)
      s.inTransaction(() => s.repository.save(ask))
      s.inTransaction(() => s.repository.settle(ask.id as AskId, { requestId: 'r-1' }))

      s.inTransaction(() =>
        s.repository.settleAnswer('r-1', { kind: 'refused', reason: 'channel-unavailable' })
      )

      expect(s.repository.answerOf('r-1')?.outcome).toStrictEqual({
        kind: 'refused',
        reason: 'channel-unavailable'
      })
      expect(() =>
        s.inTransaction(() => s.repository.settleAnswer('r-1', { kind: 'accepted' }))
      ).toThrow()
      expect(() =>
        s.inTransaction(() => s.repository.settleAnswer('r-unknown', { kind: 'accepted' }))
      ).toThrow()
      expect(s.reopen().answerOf('r-1')?.outcome).toStrictEqual({
        kind: 'refused',
        reason: 'channel-unavailable'
      })
    })

    it("[ADR-010] recordOf returns the ask's linked record, also once a re-answer settled a new request, and null before any link", async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfs
      const ask = permissionAsk(15, dwarf)
      const othersAsk = permissionAsk(16, other)
      s.inTransaction(() => {
        s.repository.save(ask)
        s.repository.save(othersAsk)
      })
      const id = ask.id as AskId
      s.inTransaction(() => s.repository.settle(id, { requestId: 'r-1' }))
      expect(s.repository.recordOf(id)).toBeNull()

      const record = s.seedRecord(dwarf, id)
      s.inTransaction(() => {
        s.repository.linkRecord('r-1', record)
        s.repository.settleAnswer('r-1', { kind: 'refused', reason: 'invalid-answer' })
        s.repository.save({ ...ask, state: 'open' })
      })
      // The re-answer wins the reopened ask: its new request finds the same record to update.
      s.inTransaction(() => s.repository.settle(id, { requestId: 'r-2' }))

      expect(s.repository.recordOf(id)).toBe(record)
      expect(s.reopen().recordOf(id)).toBe(record)
      expect(s.repository.recordOf(othersAsk.id as AskId)).toBeNull()
      expect(() => s.inTransaction(() => s.repository.linkRecord('r-unknown', record))).toThrow()
    })

    // ---------- owner amendment L (2026-10-09): the live asks of every dwarf ----------

    it('[ADR-010, INV-70] live lists every open or answering ask of every dwarf oldest first by openedAt, queued asks included', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfs
      // Saved out of order; the ids run against openedAt, so only openedAt can give this order.
      const queued = questionAsk(21, dwarf, { openedAt: T0 + 300 })
      const othersAsk = permissionAsk(22, other, { openedAt: T0 + 200 })
      const front = permissionAsk(23, dwarf, { openedAt: T0 + 100 })
      s.inTransaction(() => {
        s.repository.save(queued)
        s.repository.save(othersAsk)
        s.repository.save(front)
      })
      s.inTransaction(() => s.repository.settle(front.id as AskId, { requestId: 'r-front' }))

      expect(s.repository.live()).toStrictEqual([
        { ...front, state: 'answering' },
        othersAsk,
        queued
      ])
    })

    it('[ADR-010] live never lists a closed ask', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfs
      const open = permissionAsk(31, other)
      const closingStates = [
        'answered-in-app',
        'answered-elsewhere',
        'cancelled',
        'closed-by-death',
        'auto-denied'
      ] as const
      s.inTransaction(() => {
        closingStates.forEach((state, i) =>
          s.repository.save(permissionAsk(32 + i, dwarf, { state, closedAt: T0 + 90 }))
        )
        s.repository.save(open)
      })

      expect(s.repository.live()).toStrictEqual([open])
      s.inTransaction(() => s.repository.save({ ...open, state: 'cancelled', closedAt: T0 + 91 }))
      expect(s.repository.live()).toStrictEqual([])
    })

    it('[ADR-010, US-RES-003.AC09] live reads the stored asks back after the repository is reopened, a reopened ask among them', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfs
      const ask = questionAsk(41, dwarf, { currentStep: 2 })
      const othersAsk = permissionAsk(42, other)
      s.inTransaction(() => {
        s.repository.save(ask)
        s.repository.save(othersAsk)
      })
      // A refused answer puts the ask back to open (ADR-010 item 13; US-ASK-007).
      s.inTransaction(() => s.repository.settle(ask.id as AskId, { requestId: 'r-1' }))
      s.inTransaction(() => {
        s.repository.settleAnswer('r-1', { kind: 'refused', reason: 'channel-rejected' })
        s.repository.save({ ...ask, state: 'open' })
      })

      expect(s.reopen().live()).toStrictEqual([ask, othersAsk])
    })
  })
}
