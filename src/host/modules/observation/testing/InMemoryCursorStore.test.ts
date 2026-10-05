// layer: L3
// L3 (17 §1.3): the CursorStore conformance suite on its in-memory double.
import { describe } from 'vitest'
import { InMemoryTransactions } from './inMemoryTransactions'
import { runCursorStoreContract } from './cursorStore.contract'
import { InMemoryCursorStore } from '../ports/fakes/InMemoryCursorStore'

describe('InMemoryCursorStore', () => {
  runCursorStoreContract(() => {
    const transactions = new InMemoryTransactions()
    const store = new InMemoryCursorStore(transactions)
    transactions.enlist(store)
    return { store, inTransaction: (work) => transactions.inTransaction(work) }
  })
})
