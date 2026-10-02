import { describe } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { carryOverKey } from '../domain/carryOver'
import {
  InMemoryAttentionLedger,
  InMemoryAttentionRows
} from '../ports/fakes/InMemoryAttentionLedger'
import { runAttentionLedgerContract } from './attentionLedger.contract'

// L3 (17 §1.3): the double runs the same contract as the SQLite adapter. Its "database" is an
// `InMemoryAttentionRows`; a reopen is a new ledger over the same rows.
describe('InMemoryAttentionLedger', () => {
  runAttentionLedgerContract(() => {
    const rows = new InMemoryAttentionRows()
    const clock = new FakeClock(1_790_000_000_000)
    let asks = 0
    return {
      ledger: new InMemoryAttentionLedger(rows, clock),
      dwarfs: ['dwarf-0001' as DwarfId, 'dwarf-0002' as DwarfId],
      inTransaction: (work) => work(),
      openAsk: () => `ask-${++asks}`,
      recordCarryOver: (dwarfId, kind, preCrashKey) =>
        rows.announced.set(carryOverKey(dwarfId, kind), preCrashKey),
      reopen: () => new InMemoryAttentionLedger(rows, clock),
      clock,
      dispose: () => undefined
    }
  })
})
