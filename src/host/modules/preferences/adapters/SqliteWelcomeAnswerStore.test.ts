import { describe } from 'vitest'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { runWelcomeAnswerStoreContract } from '../testing/welcomeAnswerStore.contract'
import { SqliteWelcomeAnswerStore } from './SqliteWelcomeAnswerStore'

// L3 (17 §1.3): the contract over a copy of the run's template database (schema v1, migration 1
// applied and seeded), so the answer meets the real `app_meta` row and its CHECK (09 D-25). The
// Reset clear is the statement of the saga's `db` step (SqliteResetJournal, 07 S13.01).
describe('SqliteWelcomeAnswerStore', () => {
  runWelcomeAnswerStoreContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    return {
      store: new SqliteWelcomeAnswerStore({ db }),
      inTransaction: (work) => runner.inTransaction(work),
      clearAsReset: () =>
        runner.inTransaction(() =>
          db.run(
            'UPDATE app_meta SET reset_epoch = reset_epoch + 1, welcome_answered_at = NULL WHERE id = 1'
          )
        ),
      dispose: () => undefined
    }
  })
})
