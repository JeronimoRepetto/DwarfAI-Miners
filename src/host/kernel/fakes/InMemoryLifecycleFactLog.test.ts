import { describe } from 'vitest'
import { runLifecycleFactLogContract } from '../testing/lifecycleFactLog.contract'
import type { TransactionScope } from '../ports/transactionScope'
import { InMemoryLifecycleFactLog } from './InMemoryLifecycleFactLog'

// The double runs the same contract as the SQLite adapter (17 §1.3). Its transaction is a
// TransactionScope fake: open while `work` runs, and a throwing `work` restores the rows it saw.
describe('InMemoryLifecycleFactLog', () => {
  runLifecycleFactLogContract(() => {
    let open = false
    const scope: TransactionScope = { isInTransaction: () => open }
    const log = new InMemoryLifecycleFactLog(scope)
    return {
      log,
      dwarfIds: ['00000000-0000-7000-8000-00000000000a', '00000000-0000-7000-8000-00000000000b'],
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
      facts: () => log.rows(),
      dispose: () => undefined
    }
  })
})
