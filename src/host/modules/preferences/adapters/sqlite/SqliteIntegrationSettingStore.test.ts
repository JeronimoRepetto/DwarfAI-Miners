import { describe } from 'vitest'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import { runIntegrationSettingStoreContract } from '../../testing/integrationSettingStore.contract'
import { SqliteIntegrationSettingStore } from './SqliteIntegrationSettingStore'

// L3 (17 §1.3): the contract over a copy of the template database, so every row meets the real
// CHECKs of `integration_settings` (09 §4.8) and starts from the migration-1 seed (09 §4.9).
describe('SqliteIntegrationSettingStore', () => {
  runIntegrationSettingStoreContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    return {
      store: new SqliteIntegrationSettingStore({ db }),
      inTransaction: (work) => runner.inTransaction(work)
    }
  })
})
