import { describe } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import { runPreferencesStoreContract } from '../../testing/preferencesStore.contract'
import { SqlitePreferencesStore } from './SqlitePreferencesStore'

// L3 (17 §1.3): the contract over a copy of the run's template database (schema v1, migration 1
// applied with its seed rows, 09 §4.9), so every row meets the real CHECKs of `host_preferences`.
describe('SqlitePreferencesStore', () => {
  runPreferencesStoreContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    const clock = new FakeClock(1_750_000_000_000)
    return {
      store: new SqlitePreferencesStore({ db, clock }),
      inTransaction: (work) => runner.inTransaction(work),
      rowCount: () => Number(db.all('SELECT count(*) AS n FROM host_preferences')[0]?.['n']),
      setOpenCodeIntegration: (state) =>
        runner.inTransaction(() => {
          db.run(
            `UPDATE integration_settings SET state = ?, consent_origin = ?, changed_at = ?
             WHERE id = 'opencode-permissions'`,
            [state, state === 'off' ? null : 'settings', clock.now()]
          )
        }),
      dispose: () => undefined
    }
  })
})
