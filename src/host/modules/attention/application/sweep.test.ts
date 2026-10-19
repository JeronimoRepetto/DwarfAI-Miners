// layer: L2
// L2 (17 §1.2): the maintenance sweep of 09 §7.1 over InMemoryAttentionLedger and a FakeClock:
// withdrawn keys are deleted 24 hours after `withdrawn_at`, in statements of at most 1 000 rows.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import type { DwarfId } from '../../../kernel/domain/values'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import {
  InMemoryAttentionLedger,
  InMemoryAttentionRows
} from '../ports/fakes/InMemoryAttentionLedger'
import { SWEEP_BATCH, WITHDRAWN_KEY_RETENTION_MS, sweepWithdrawnKeys } from './sweep'

const T0 = 1_790_000_000_000
const DWARF = 'dwarf-0001' as DwarfId
const key = (n: number): string => `${DWARF}:turn-finished:turn-${n}`

/** Records the limit of each sweep statement and whether it ran inside a transaction. */
class RecordingSweepLedger extends InMemoryAttentionLedger {
  readonly sweeps: { limit: number; inTransaction: boolean }[] = []
  constructor(
    rows: InMemoryAttentionRows,
    clock: FakeClock,
    private readonly open: () => boolean
  ) {
    super(rows, clock)
  }
  override sweepWithdrawn(before: number, limit: number): number {
    this.sweeps.push({ limit, inTransaction: this.open() })
    return super.sweepWithdrawn(before, limit)
  }
}

function subject() {
  const clock = new FakeClock(T0)
  let open = false
  const transactions: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      open = true
      try {
        return work()
      } finally {
        open = false
      }
    }
  }
  const rows = new InMemoryAttentionRows()
  const ledger = new RecordingSweepLedger(rows, clock, () => open)
  return { clock, ledger, rows, sweep: () => sweepWithdrawnKeys({ ledger, transactions, clock }) }
}

describe('sweepWithdrawnKeys (09 §7.1)', () => {
  it('[ADR-018] withdrawn keys older than 24 hours are deleted and younger ones kept', () => {
    const { clock, ledger, rows, sweep } = subject()
    for (const n of [1, 2, 3]) ledger.markEmitted(key(n), DWARF, 'turn-finished')
    ledger.withdraw([key(1)])
    clock.advance(1)
    ledger.withdraw([key(2)]) // key(3) is never withdrawn: its fact is still open

    clock.advance(WITHDRAWN_KEY_RETENTION_MS) // key(1) is 24 h + 1 ms old, key(2) exactly 24 h

    expect(sweep()).toBe(1)
    expect([...rows.keys.keys()]).toStrictEqual([key(2), key(3)])
  })

  it('[ADR-018] the sweep deletes in statements of at most 1 000 rows, each in its own transaction, until none is due', () => {
    const { clock, ledger, rows, sweep } = subject()
    const due = SWEEP_BATCH * 2 + 1
    for (let n = 0; n < due; n++) ledger.markEmitted(key(n), DWARF, 'turn-finished')
    ledger.withdraw([...rows.keys.keys()])
    clock.advance(WITHDRAWN_KEY_RETENTION_MS + 1)

    expect(sweep()).toBe(due)
    expect(rows.keys.size).toBe(0)
    expect(ledger.sweeps).toStrictEqual([
      { limit: SWEEP_BATCH, inTransaction: true },
      { limit: SWEEP_BATCH, inTransaction: true },
      { limit: SWEEP_BATCH, inTransaction: true }
    ])
    expect(SWEEP_BATCH).toBe(1000)
  })
})
