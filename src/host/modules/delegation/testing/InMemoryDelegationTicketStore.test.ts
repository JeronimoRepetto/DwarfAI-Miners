import { describe } from 'vitest'
import { InMemoryDelegationTicketStore } from '../ports/fakes/InMemoryDelegationTicketStore'
import { runDelegationTicketStoreContract } from './delegationTicketStore.contract'

// L3 (17 §1.3): the double runs the same contract as the SQLite adapter. Its transaction restores
// the rows it saw when `work` throws.
describe('InMemoryDelegationTicketStore', () => {
  runDelegationTicketStoreContract(() => {
    const store = new InMemoryDelegationTicketStore()
    return {
      store,
      inTransaction: <T>(work: () => T): T => {
        const before = store.snapshot()
        try {
          return work()
        } catch (error) {
          store.restore(before)
          throw error
        }
      },
      rows: () => store.snapshot(),
      storedText: () => JSON.stringify(store.snapshot()),
      dispose: () => undefined
    }
  })
})
