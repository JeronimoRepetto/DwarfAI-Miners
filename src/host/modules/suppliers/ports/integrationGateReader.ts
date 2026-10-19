// The suppliers driven port `IntegrationGateReader` (05 §3.4, 16 §4.4; frozen): a synchronous read
// of `preferences.integrationState` through a `host/wiring` bridge, so suppliers never imports
// preferences (no module edge, 05 §1.3, R2). `IntegrationId` and `IntegrationState` are kernel
// value types. Double: `FakeIntegrationGateReader`. Type-only (R2).
import type { IntegrationId, IntegrationState } from '../../../kernel/domain/values'

export interface IntegrationGateReader {
  // bridge → preferences.integrationState (§4); no suppliers → preferences import
  state(id: IntegrationId): IntegrationState
}
