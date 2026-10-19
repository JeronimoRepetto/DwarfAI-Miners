// The IntegrationSettingStore conformance suite (16 §4.12 row `IntegrationSettingStore`; 17 §1.3):
// run on `InMemoryIntegrationSettingStore` and on `SqliteIntegrationSettingStore` over the template
// database. One row per integration, `off` with no consent on a fresh install (09 §4.9 seed), and a
// saved setting reads back as stored. Never imported by production code (R14).
import { describe, expect, it } from 'vitest'
import type { IntegrationSettingStore } from '../ports/integrationSettingStore'

export interface IntegrationSettingStoreSubject {
  store: IntegrationSettingStore
  /** Runs `work` the way the store's callers do: inside a transaction (16 §2.2). */
  inTransaction<T>(work: () => T): T
}

export function runIntegrationSettingStoreContract(
  makeSubject: () => IntegrationSettingStoreSubject | Promise<IntegrationSettingStoreSubject>
): void {
  describe('IntegrationSettingStore contract', () => {
    it('[S14.01] both integrations start off with no consent origin', async () => {
      const { store } = await makeSubject()

      expect(store.get('claude-hooks')).toMatchObject({ id: 'claude-hooks', state: 'off' })
      expect(store.get('claude-hooks').consentOrigin).toBeUndefined()
      expect(store.get('opencode-permissions')).toMatchObject({
        id: 'opencode-permissions',
        state: 'off'
      })
      expect(store.get('opencode-permissions').consentOrigin).toBeUndefined()
    })

    it('[S14.02, S14.06] a saved setting reads back as stored, and only its own integration changes', async () => {
      const { store, inTransaction } = await makeSubject()

      inTransaction(() =>
        store.save({
          id: 'opencode-permissions',
          state: 'on-verified',
          consentOrigin: 'add-panel',
          changedAt: 1_000
        })
      )
      expect(store.get('opencode-permissions')).toStrictEqual({
        id: 'opencode-permissions',
        state: 'on-verified',
        consentOrigin: 'add-panel',
        changedAt: 1_000
      })
      expect(store.get('claude-hooks').state).toBe('off')

      inTransaction(() =>
        store.save({ id: 'opencode-permissions', state: 'off', changedAt: 2_000 })
      )
      expect(store.get('opencode-permissions')).toStrictEqual({
        id: 'opencode-permissions',
        state: 'off',
        changedAt: 2_000
      })
    })
  })
}
