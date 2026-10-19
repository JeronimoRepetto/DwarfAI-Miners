// The IntegrationSettingStore double (16 §4.12 `InMemory*`): one setting per integration, `off`
// with no consent at start, as migration 1 seeds them (09 §4.9). It passes the same contract as
// `SqliteIntegrationSettingStore`. Never imported by production code (R14).
import type { IntegrationId } from '../../../../kernel/domain/values'
import type { IntegrationSetting, IntegrationSettingStore } from '../integrationSettingStore'

export class InMemoryIntegrationSettingStore implements IntegrationSettingStore {
  private readonly settings = new Map<IntegrationId, IntegrationSetting>()

  constructor(startedAt = 0) {
    for (const id of ['opencode-permissions', 'claude-hooks'] as const) {
      this.settings.set(id, { id, state: 'off', changedAt: startedAt })
    }
  }

  get(id: IntegrationId): IntegrationSetting {
    const setting = this.settings.get(id)
    if (setting === undefined) throw new Error(`InMemoryIntegrationSettingStore: no setting ${id}`)
    return { ...setting }
  }

  save(s: IntegrationSetting): void {
    this.settings.set(s.id, { ...s })
  }
}
