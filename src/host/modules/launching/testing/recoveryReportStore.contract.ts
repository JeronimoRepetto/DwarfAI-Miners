// The RecoveryReportStore conformance suite (16 §4.5; 17 §1.3): run on the in-memory double and on
// the SQLite adapter over the template database. One report per Host epoch (INV-58), pending until
// each item is settled, an item settled once (ADR-015 item 5; OQ-41 A, OQ-43), every write inside
// the caller's transaction (16 §2.2).
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId } from '../../../kernel/domain/values'
import type { HostRecoveryReport } from '../domain/recoveryReport'
import type { RecoveryReportStore } from '../ports/recoveryReportStore'

export interface RecoveryReportStoreSubject {
  store: RecoveryReportStore
  /** Three dwarfs that exist in the subject's store (the SQLite half seeds their `dwarfs` rows). */
  dwarfs: readonly [DwarfId, DwarfId, DwarfId]
  /** The stored retry outcome of a listed dwarf, null while it has none. */
  retryOutcome(hostEpoch: string, dwarfId: DwarfId): 'resumed' | 'failed' | null
  /** The stored first-display instant of the report, null while no UI showed it. */
  shownAt(hostEpoch: string): number | null
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  dispose(): void | Promise<void>
}

const EPOCH = 'epoch-0173'
const AT = 1_790_000_000_000

function report(s: RecoveryReportStoreSubject): HostRecoveryReport {
  const [a, b, c] = s.dwarfs
  return {
    hostEpoch: EPOCH,
    at: AT,
    resumed: [c],
    unrecovered: [
      { dwarfId: a, reason: 'no-resume' },
      { dwarfId: b, reason: 'turn-lost', messageIds: ['00000000-0000-7000-8000-0000000173e1'] }
    ]
  }
}

export function runRecoveryReportStoreContract(
  makeSubject: () => RecoveryReportStoreSubject | Promise<RecoveryReportStoreSubject>
): void {
  describe('RecoveryReportStore', () => {
    let subject: RecoveryReportStoreSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async () => {
      subject = await makeSubject()
      return subject
    }

    it('[ADR-015] a saved report is pending until each of its items is settled, and markShown keeps it pending', async () => {
      const s = await setUp()
      const [a, b] = s.dwarfs
      expect(s.store.pending()).toBeNull()
      s.inTransaction(() => s.store.save(report(s)))

      expect(s.store.pending()).toEqual(report(s))
      s.inTransaction(() => s.store.markShown(EPOCH, AT + 10))
      s.inTransaction(() => s.store.markShown(EPOCH, AT + 20))
      expect(s.shownAt(EPOCH)).toBe(AT + 10)
      expect(s.store.pending()).toEqual(report(s))

      s.inTransaction(() => s.store.settleItem(EPOCH, a, 'resumed'))
      expect(s.store.pending()?.hostEpoch).toBe(EPOCH)
      s.inTransaction(() => s.store.settleItem(EPOCH, b, 'failed'))
      expect(s.store.pending()).toBeNull()
    })

    it('[ADR-015] settleItem records resumed, failed or dismissed once per dwarf and a second settle changes nothing', async () => {
      const s = await setUp()
      const [a, b, c] = s.dwarfs
      s.inTransaction(() =>
        s.store.save({
          ...report(s),
          resumed: [],
          unrecovered: [...report(s).unrecovered, { dwarfId: c, reason: 'stale-ref' }]
        })
      )

      s.inTransaction(() => s.store.settleItem(EPOCH, a, 'resumed'))
      s.inTransaction(() => s.store.settleItem(EPOCH, a, 'failed'))
      s.inTransaction(() => s.store.settleItem(EPOCH, b, 'failed'))
      s.inTransaction(() => s.store.settleItem(EPOCH, b, 'resumed'))
      s.inTransaction(() => s.store.settleItem(EPOCH, c, 'dismissed'))
      s.inTransaction(() => s.store.settleItem(EPOCH, c, 'resumed'))
      s.inTransaction(() => s.store.settleItem('another-epoch', a, 'failed'))

      expect(s.retryOutcome(EPOCH, a)).toBe('resumed')
      expect(s.retryOutcome(EPOCH, b)).toBe('failed')
      expect(s.retryOutcome(EPOCH, c)).toBeNull()
      expect(s.store.pending()).toBeNull()
    })

    it('[INV-58] a second save of the same epoch updates its one report and keeps each item its first reason', async () => {
      const s = await setUp()
      const [a, b, c] = s.dwarfs
      s.inTransaction(() =>
        s.store.save({ ...report(s), unrecovered: [report(s).unrecovered[0]!] })
      )
      s.inTransaction(() =>
        s.store.save({
          ...report(s),
          resumed: [b],
          unrecovered: [
            {
              dwarfId: a,
              reason: 'resume-error',
              messageIds: ['00000000-0000-7000-8000-0000000173e2']
            },
            { dwarfId: c, reason: 'stale-ref' }
          ]
        })
      )

      expect(s.store.pending()).toEqual({
        hostEpoch: EPOCH,
        at: AT,
        resumed: [b],
        unrecovered: [
          { dwarfId: a, reason: 'no-resume', messageIds: ['00000000-0000-7000-8000-0000000173e2'] },
          { dwarfId: c, reason: 'stale-ref' }
        ]
      })
    })

    it('[ADR-015] a write outside a transaction is refused and a rolled-back save leaves nothing', async () => {
      const s = await setUp()
      const [a] = s.dwarfs
      expect(() => s.store.save(report(s))).toThrow(HostInvariantError)
      expect(() =>
        s.inTransaction(() => {
          s.store.save(report(s))
          throw new Error('the caller failed after saving')
        })
      ).toThrow('the caller failed after saving')
      expect(s.store.pending()).toBeNull()
      s.inTransaction(() => s.store.save(report(s)))
      expect(() => s.store.markShown(EPOCH, AT)).toThrow(HostInvariantError)
      expect(() => s.store.settleItem(EPOCH, a, 'resumed')).toThrow(HostInvariantError)
      expect(s.retryOutcome(EPOCH, a)).toBeNull()
    })
  })
}
