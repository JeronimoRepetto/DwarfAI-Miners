import { describe } from 'vitest'
import { InMemoryIntegrationSettingStore } from '../ports/fakes/InMemoryIntegrationSettingStore'
import { runIntegrationSettingStoreContract } from './integrationSettingStore.contract'

// The double runs the same suite as SqliteIntegrationSettingStore (17 §1.3).
describe('InMemoryIntegrationSettingStore', () => {
  runIntegrationSettingStoreContract(() => ({
    store: new InMemoryIntegrationSettingStore(),
    inTransaction: (work) => work()
  }))
})
