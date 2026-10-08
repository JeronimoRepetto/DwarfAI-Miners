// Driven port (05 §3.12, 16 §4.12): one `integration_settings` row per integration (09 §4.8), the
// state the Settings toggles show and the consent that turned it on (ADR-011 item 7; ADR-016 item
// 5). Synchronous, inside the caller's transaction (16 §2.2). The `ExternalConfigWriter` engine
// writes it in its Tx B (16 §7.3) and after a revert (16 §7.4).
import type { Instant, IntegrationId, IntegrationState } from '../../../kernel/domain/values'
import type { ConsentOrigin } from './externalConfigWriter'

/**
 * 06 §14 `IntegrationSetting`: `consentOrigin` is present exactly when the state is not `off`
 * (09 CHECK), and `add-panel` only for `opencode-permissions`.
 */
export interface IntegrationSetting {
  id: IntegrationId
  state: IntegrationState
  consentOrigin?: ConsentOrigin
  changedAt: Instant
}

// As 16 §4.12 writes it
export interface IntegrationSettingStore {
  get(id: IntegrationId): IntegrationSetting
  save(s: IntegrationSetting): void
} // integration_settings (06 IntegrationSetting)
