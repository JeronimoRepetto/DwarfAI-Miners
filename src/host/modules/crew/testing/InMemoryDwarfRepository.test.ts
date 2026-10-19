import { describe } from 'vitest'
import type { MineId } from '../../../kernel/domain/values'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import { runDwarfRepositoryContract } from './dwarfRepository.contract'
import { InMemoryDwarfRepository } from './InMemoryDwarfRepository'

// The double runs the same contract as the SQLite adapter (17 §1.3). Its transaction is a
// TransactionScope fake: open while `work` runs, and a throwing `work` restores the rows it saw.
describe('InMemoryDwarfRepository', () => {
  runDwarfRepositoryContract(() => {
    let open = false
    const scope: TransactionScope = { isInTransaction: () => open }
    const repository = new InMemoryDwarfRepository(scope)
    return {
      repository,
      mineIds: [
        '00000000-0000-7000-8000-0000000000f1' as MineId,
        '00000000-0000-7000-8000-0000000000f2' as MineId
      ],
      inTransaction: <T>(work: () => T): T => {
        const before = repository.snapshot()
        open = true
        try {
          return work()
        } catch (error) {
          repository.restore(before)
          throw error
        } finally {
          open = false
        }
      },
      dispose: () => undefined
    }
  })
})
