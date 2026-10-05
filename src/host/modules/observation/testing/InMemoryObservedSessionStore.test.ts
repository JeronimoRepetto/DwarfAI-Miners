// layer: L3
// L3 (17 §1.3): the ObservedSessionStore conformance suite on its in-memory double.
import { describe } from 'vitest'
import { InMemoryObservedSessionStore } from '../ports/fakes/InMemoryObservedSessionStore'
import { InMemoryBoundDwarfs } from './inMemoryBoundDwarfs'
import { runObservedSessionStoreContract } from './observedSessionStore.contract'
import { InMemoryTransactions } from './inMemoryTransactions'

describe('InMemoryObservedSessionStore', () => {
  runObservedSessionStoreContract(() => {
    const transactions = new InMemoryTransactions()
    const dwarfs = new InMemoryBoundDwarfs()
    const store = new InMemoryObservedSessionStore(transactions, dwarfs)
    transactions.enlist(store)
    return {
      store,
      inTransaction: (work) => transactions.inTransaction(work),
      bindDwarf: (identity, folder, at) => dwarfs.bind(identity, folder, at),
      departDwarf: (dwarfId, at) => dwarfs.depart(dwarfId, at),
      rowCount: () => store.rowCount()
    }
  })
})
