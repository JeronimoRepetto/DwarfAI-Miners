// layer: L3
// L3 (17 §1.3): the EndedAgentLedger conformance suite on its in-memory double.
import { describe } from 'vitest'
import { InMemoryEndedAgentLedger } from '../ports/fakes/InMemoryEndedAgentLedger'
import { runEndedAgentLedgerContract } from './endedAgentLedger.contract'
import { InMemoryTransactions } from './inMemoryTransactions'

describe('InMemoryEndedAgentLedger', () => {
  runEndedAgentLedgerContract(() => {
    const transactions = new InMemoryTransactions()
    const ledger = new InMemoryEndedAgentLedger(transactions)
    transactions.enlist(ledger)
    return { ledger, inTransaction: (work) => transactions.inTransaction(work) }
  })
})
