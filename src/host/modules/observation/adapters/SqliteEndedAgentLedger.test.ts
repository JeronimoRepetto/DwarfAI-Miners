// layer: L3
// L3 (17 §1.3): the EndedAgentLedger conformance suite over a copy of the run's template database
// (schema v1), so every write meets the real `ended_agents` key and CHECKs (09 §4.2).
import { describe } from 'vitest'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { runEndedAgentLedgerContract } from '../testing/endedAgentLedger.contract'
import { SqliteEndedAgentLedger } from './SqliteEndedAgentLedger'

describe('SqliteEndedAgentLedger', () => {
  runEndedAgentLedgerContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    return {
      ledger: new SqliteEndedAgentLedger({ db, scope: runner }),
      inTransaction: (work) => runner.inTransaction(work)
    }
  })
})
