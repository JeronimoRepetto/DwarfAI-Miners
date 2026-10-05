// layer: L3
// L3 (17 §1.3): the LedgerRepository contract over a copy of the run's template database (schema
// v1, migration 1 applied), so every row meets the real CHECKs, UNIQUE keys, foreign keys and the
// `material_totals` triggers of 09 §4.7.
import { describe } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { runLedgerRepositoryContract } from '../testing/ledgerRepository.contract'
import { sqliteLedgerSeeds } from '../testing/sqliteLedgerSeeds'
import { SqliteLedgerRepository } from './SqliteLedgerRepository'

describe('SqliteLedgerRepository', () => {
  runLedgerRepositoryContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    const ids = new SequenceIdGenerator()
    const clock = new FakeClock(1_760_000_000_000)
    const seeds = sqliteLedgerSeeds(db, runner)
    return {
      repository: new SqliteLedgerRepository({ db, scope: runner, ids, clock }),
      inTransaction: (work) => runner.inTransaction(work),
      addMine: seeds.addMine,
      addDwarf: seeds.addDwarf,
      setInstallMoment: seeds.setInstallMoment,
      setResetInProgress: seeds.setResetInProgress,
      entries: seeds.entries,
      entryIds: seeds.entryIds,
      dispose: () => undefined
    }
  })
})
