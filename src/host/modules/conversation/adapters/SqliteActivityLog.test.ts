import { describe } from 'vitest'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { runActivityLogContract } from '../testing/activityLog.contract'
import { seedConversationDb, storedOutcome, storedRuns } from '../testing/sqliteConversationDb'
import { SqliteActivityLog } from './SqliteActivityLog'

// L3 (17 §1.3): the contract over a copy of the run's template database (schema v1, migration 1
// applied), with one mine and two dwarfs seeded, so every run meets the real CHECKs, the UNIQUE
// `(dwarf_id, turn_key)`, the partial index `activity_disclosures_one_open` and the foreign key of
// `activity_disclosures`, and the CHECKs and foreign key of `outcome_lines` (09 §4.4).
const T0 = 1_790_000_000_000

describe('SqliteActivityLog', () => {
  runActivityLogContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    const dwarfIds = seedConversationDb(db, runner, T0)
    return {
      log: new SqliteActivityLog({ db, scope: runner }),
      dwarfIds,
      inTransaction: (work) => runner.inTransaction(work),
      runs: (dwarfId) => storedRuns(db, dwarfId),
      outcome: (dwarfId) => storedOutcome(db, dwarfId),
      reopen: () => new SqliteActivityLog({ db, scope: runner }),
      dispose: () => undefined
    }
  })
})
