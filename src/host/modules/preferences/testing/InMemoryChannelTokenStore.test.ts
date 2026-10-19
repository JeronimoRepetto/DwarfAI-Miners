import { describe } from 'vitest'
import { runChannelTokenStoreContract } from './channelTokenStore.contract'
import { InMemoryChannelTokenStore } from '../ports/fakes/InMemoryChannelTokenStore'

// L3 (17 §1.3): the double runs the same contract as the SQLite adapter. Its transaction restores
// the rows it saw when `work` throws.
describe('InMemoryChannelTokenStore', () => {
  runChannelTokenStoreContract(() => {
    const store = new InMemoryChannelTokenStore()
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
