import { describe } from 'vitest'
import { InMemoryWelcomeAnswerStore } from '../ports/fakes/InMemoryWelcomeAnswerStore'
import { runWelcomeAnswerStoreContract } from './welcomeAnswerStore.contract'

// L3 (17 §1.3): the double runs the same contract as the SQLite adapter. Its transaction restores
// the answer it saw when `work` throws; the Reset clear is `restore(null)`.
describe('InMemoryWelcomeAnswerStore', () => {
  runWelcomeAnswerStoreContract(() => {
    const store = new InMemoryWelcomeAnswerStore()
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
      clearAsReset: () => store.restore(null),
      dispose: () => undefined
    }
  })
})
