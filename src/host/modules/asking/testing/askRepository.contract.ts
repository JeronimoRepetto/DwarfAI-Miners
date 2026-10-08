// The AskRepository conformance suite (16 §4.7 doubles row: "settle idempotent,
// `asks_one_answering`"; 17 §1.3): run on `InMemoryAskRepository` and on `SqliteAskRepository`
// over the template database. An ask saved by one repository is read back by a new repository over
// the same storage, as after a Host restart, with its payload and current step and nothing picked
// on earlier steps (ADR-010 item 9, INV-75, OQ-03). Never imported by production code (R14).
import { afterEach, describe, expect, it } from 'vitest'
import type { AskId, DwarfId } from '../../../kernel/domain/values'
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
  })
}
