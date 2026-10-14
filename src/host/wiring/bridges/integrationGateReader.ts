// The `IntegrationGateReader` bridge (16 §4.4, §8.3 `bgate --> sup`, `bgate --> pref`): suppliers
// reads an integration's state through it, so suppliers never imports preferences (05 §1.3, R2).
//
// It reads `PreferencesQueries.integrationState` on every call (no cache, 05 §4; 16 §4.4 "re-derived
// on every call"): the stored state in `integration_settings` (ISSUE-221), which the cut-2 config
// writer (ISSUE-323) turns `on-verified` or back to `off`. A fresh database answers `off` for every
// integration, the new-install value (ADR-011 item 7; 18 C-27), so a gated provider's answer channel
// stays closed until the person turns its integration on.
import type { PreferencesQueries } from '../../modules/preferences'
import type { IntegrationGateReader } from '../../modules/suppliers'

export function preferencesIntegrationGate(
  queries: Pick<PreferencesQueries, 'integrationState'>
): IntegrationGateReader {
  return { state: (id) => queries.integrationState(id) }
}
