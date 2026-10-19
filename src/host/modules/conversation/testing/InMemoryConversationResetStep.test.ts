import { describe } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import { InMemoryActivityLog } from './InMemoryActivityLog'
import { InMemoryConversationResetStep } from './InMemoryConversationResetStep'
import { InMemoryMessageLog } from './InMemoryMessageLog'
import { runConversationResetStepContract } from './resetStep.contract'

// The double runs the same contract as the SQLite step (17 §1.3). Its transaction joins an open
// one, and the outermost work that throws restores what the log and the runs held before it.
//
// TC-107-01, TC-107-02.
const T0 = 1_790_000_000_000

describe('InMemoryConversationResetStep', () => {
  runConversationResetStepContract(() => {
    let open = false
    const scope: TransactionScope = { isInTransaction: () => open }
    const log = new InMemoryMessageLog({
      scope,
      clock: new FakeClock(T0),
      ids: new SequenceIdGenerator()
    })
    const activity = new InMemoryActivityLog({ scope })
    const transactions: TransactionRunner = {
      inTransaction<T>(work: () => T): T {
        if (open) return work()
        const before = { log: log.snapshot(), activity: activity.snapshot() }
        open = true
        try {
          return work()
        } catch (error) {
          log.restore(before.log)
          activity.restore(before.activity)
          throw error
        } finally {
          open = false
        }
      }
    }
    return {
      step: new InMemoryConversationResetStep({ scope, log, activity }),
      transactions,
      log,
      activity,
      dwarfIds: [
        '00000000-0000-7000-8000-0000000000d1' as DwarfId,
        '00000000-0000-7000-8000-0000000000d2' as DwarfId
      ],
      seedSendingRow: (dwarfId, text) => log.seedSendingRow(dwarfId, text),
      seedAnswersRecord: (dwarfId, text, phase) => log.seedAnswersRecord(dwarfId, text, phase),
      keyOf: (sourceKey) => log.keyOf(sourceKey),
      runs: (dwarfId) => activity.runs(dwarfId),
      dispose: () => undefined
    }
  })
})
