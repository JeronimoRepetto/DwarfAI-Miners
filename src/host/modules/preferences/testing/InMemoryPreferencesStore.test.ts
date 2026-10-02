import { describe } from 'vitest'
import { runPreferencesStoreContract } from './preferencesStore.contract'
import { InMemoryPreferencesStore } from '../ports/fakes/InMemoryPreferencesStore'

// L3 (17 §1.3): the double runs the same contract as the SQLite adapter. Its transaction restores
// the row it saw when `work` throws.
describe('InMemoryPreferencesStore', () => {
  runPreferencesStoreContract(() => {
    const store = new InMemoryPreferencesStore()
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
      rowCount: () => 1,
      setOpenCodeIntegration: (state) => store.setOpenCodeIntegration(state),
      dispose: () => undefined
    }
  })
})
