// layer: L3
// L3 (17 §1.3): the double runs the same contract suite as the SQLite adapter (16 §2.8).
import { describe } from 'vitest'
import { inMemoryLedgerSubject } from './inMemoryLedger'
import { runLedgerRepositoryContract } from './ledgerRepository.contract'

describe('InMemoryLedgerRepository', () => {
  runLedgerRepositoryContract(inMemoryLedgerSubject)
})
