import type { DwarfId } from '../../../kernel/domain/values'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import { InMemoryRecoveryReportStore } from './InMemoryRecoveryReportStore'
import { runRecoveryReportStoreContract } from './recoveryReportStore.contract'

// L3 (17 §1.3): the double runs the same suite as the SQLite adapter.
runRecoveryReportStoreContract(() => {
  let open = false
  const scope: TransactionScope = { isInTransaction: () => open }
  const store = new InMemoryRecoveryReportStore(scope)
  return {
    store,
    dwarfs: [
      '00000000-0000-7000-8000-0000000173d1' as DwarfId,
      '00000000-0000-7000-8000-0000000173d2' as DwarfId,
      '00000000-0000-7000-8000-0000000173d3' as DwarfId
    ],
    retryOutcome: (epoch, dwarfId) => store.retryOutcome(epoch, dwarfId),
    shownAt: (epoch) => store.shownAt(epoch),
    inTransaction: (work) => {
      const before = store.snapshot()
      open = true
      try {
        return work()
      } catch (error) {
        store.restore(before)
        throw error
      } finally {
        open = false
      }
    },
    dispose: () => undefined
  }
})
