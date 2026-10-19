// layer: L2
// L2 (17 §1.2): launching's `markStoppedByPerson` (05 §3.5; 16 §4.5 row `markStoppedByPerson`,
// §2.3; 07 S4.05; PO #62), the required route target of `DwarfStopRequested`: it commits
// `stopped_by_person` on the dwarf's live record in its own transaction, so the person's stop is
// persisted before the end runs, and a store that cannot write throws to the publishing command.
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { LaunchRecordStore } from '../ports/launchRecordStore'
import { MarkStoppedByPerson } from './markStoppedByPerson'

const DWARF = '00000000-0000-7000-8000-000000000171' as DwarfId

/** A record store that notes each mark and whether a transaction was open around it. */
function world(options: { failWrite?: boolean } = {}) {
  let open = false
  const committed: DwarfId[] = []
  const marks: Array<{ dwarfId: DwarfId; inTransaction: boolean }> = []
  const transactions: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      open = true
      try {
        const result = work()
        committed.push(...marks.map((mark) => mark.dwarfId).slice(committed.length))
        return result
      } finally {
        open = false
      }
    }
  }
  const records: Pick<LaunchRecordStore, 'markStoppedByPerson'> = {
    markStoppedByPerson: (dwarfId) => {
      if (options.failWrite === true) throw new Error('the launch_records write failed')
      marks.push({ dwarfId, inTransaction: open })
    }
  }
  return { marker: new MarkStoppedByPerson({ records, transactions }), marks, committed }
}

describe('LaunchCommands.markStoppedByPerson (16 §4.5)', () => {
  it("[FM-060, S4.05] markStoppedByPerson commits stopped_by_person on the dwarf's record in its own transaction", () => {
    const w = world()

    w.marker.mark(DWARF)

    expect(w.marks).toStrictEqual([{ dwarfId: DWARF, inTransaction: true }])
    expect(w.committed).toStrictEqual([DWARF])
  })

  it('[FM-060] a write that fails throws to the publishing command', () => {
    const w = world({ failWrite: true })

    expect(() => w.marker.mark(DWARF)).toThrow('the launch_records write failed')
    expect(w.committed).toStrictEqual([])
  })
})
