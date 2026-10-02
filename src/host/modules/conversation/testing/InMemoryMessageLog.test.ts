import { describe } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import { InMemoryMessageLog } from './InMemoryMessageLog'
import { runMessageLogContract } from './messageLog.contract'

// The double runs the same contract as the SQLite adapter (17 §1.3). Its transaction is a
// TransactionScope fake: open while `work` runs, and a throwing `work` restores what it saw.
const T0 = 1_790_000_000_000

describe('InMemoryMessageLog', () => {
  runMessageLogContract(() => {
    let open = false
    const scope: TransactionScope = { isInTransaction: () => open }
    const log = new InMemoryMessageLog({
      scope,
      clock: new FakeClock(T0),
      ids: new SequenceIdGenerator()
    })
    return {
      log,
      dwarfIds: [
        '00000000-0000-7000-8000-0000000000d1' as DwarfId,
        '00000000-0000-7000-8000-0000000000d2' as DwarfId
      ],
      now: T0,
      inTransaction: <T>(work: () => T): T => {
        const before = log.snapshot()
        open = true
        try {
          return work()
        } catch (error) {
          log.restore(before)
          throw error
        } finally {
          open = false
        }
      },
      seedWaitingRow: (dwarfId, correlation, text) =>
        log.seedWaitingRow(dwarfId, correlation, text),
      seedSendingRow: (dwarfId, text) => log.seedSendingRow(dwarfId, text),
      seedAnswersRecord: (dwarfId, text) => log.seedAnswersRecord(dwarfId, text),
      keyOf: (sourceKey) => log.keyOf(sourceKey),
      rowCount: (dwarfId) => log.rowCount(dwarfId),
      rowIds: (dwarfId) => log.rowIds(dwarfId),
      dispose: () => undefined
    }
  })
})
