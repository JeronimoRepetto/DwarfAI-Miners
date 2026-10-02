// The `IntegrationGateReader` bridge (16 §4.4, §8.3 `bgate --> sup`, `bgate --> pref`): suppliers
// reads an integration's state through it, so suppliers never imports preferences (05 §1.3, R2).
//
// Lead decision (2026-09-30, ISSUE-159): preferences is wired only by ISSUE-226 (EPIC-13), so until
// then the bridge is the fail-closed reader: every integration reads `off`, the new-install value
// (ADR-011 item 7; 18 C-27), and a gated provider's answer channel stays closed. The preferences
// wiring points it at `PreferencesQueries.integrationState` (later: ISSUE-226).
import type { IntegrationGateReader } from '../../modules/suppliers'

export const failClosedIntegrationGate: IntegrationGateReader = {
  state: () => 'off'
}
