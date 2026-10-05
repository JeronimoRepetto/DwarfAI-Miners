import { describe } from 'vitest'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import { CONVERSATION_DWARFS } from './sqliteConversationDb'
import { runActivityLogContract } from './activityLog.contract'
import { InMemoryActivityLog } from './InMemoryActivityLog'

// The double runs the same contract as the SQLite adapter (17 §1.3). Its transaction is a
// TransactionScope fake: open while `work` runs, and a throwing `work` restores what it saw.
describe('InMemoryActivityLog', () => {
  runActivityLogContract(() => {
    let open = false
    const scope: TransactionScope = { isInTransaction: () => open }
    const log = new InMemoryActivityLog({ scope })
    return {
      log,
      dwarfIds: CONVERSATION_DWARFS,
      inTransaction: <T>(work: () => T): T => {
        if (open) return work()
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
      runs: (dwarfId) => log.runs(dwarfId),
      reopen: () => log.reopen(),
      dispose: () => undefined
    }
  })
})
