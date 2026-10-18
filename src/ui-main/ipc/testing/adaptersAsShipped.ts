// The legacy-bridge listing an earlier release shipped (21 §3, §3.1), for the router tests that check an earlier
// release's table as it shipped (`testing/cut*Routes.ts`). Test-only (05 R14): no production path imports it.
//
// ADDED for ISSUE-236, the 4a retirement: `ResetFanout` and `SettingsMirrorBridge` (cuts 1–3e) and
// `JevSettingsShapeAdapter` (3a–4a) left `LEGACY_BRIDGE_ADAPTERS` with their code, but the 1…4a tables that named them
// still name them as they shipped, so those tables are checked against the listing with them in it.
//
// AMENDED for ISSUE-240, the 4b deletion: `LegacyLaunchObservation` (cuts 1–4b) and the shape adapters
// `PerProviderShapeAdapter` and `CatalogMergeAdapter` (3a–4b) left with the same rule.
import type { StepId } from '@dwarfai/contracts'
import { STEP_ORDER } from '@dwarfai/contracts'
import type { LegacyBridgeAdapter } from '../channelRoute'
import { LEGACY_BRIDGE_ADAPTERS } from '../routes'

const span = (from: StepId, to: StepId): StepId[] =>
  STEP_ORDER.slice(STEP_ORDER.indexOf(from), STEP_ORDER.indexOf(to) + 1)

/** The bridges a retirement deleted, with the cuts they lived in (21 §3, §3.1). */
export const RETIRED_BRIDGE_ADAPTERS: readonly LegacyBridgeAdapter[] = [
  { name: 'ResetFanout', cuts: span('cut-1', 'cut-3e'), shapeAdapter: true },
  { name: 'SettingsMirrorBridge', cuts: span('cut-1', 'cut-3e'), shapeAdapter: false },
  { name: 'JevSettingsShapeAdapter', cuts: span('cut-3a', 'cut-4a'), shapeAdapter: true },
  { name: 'LegacyLaunchObservation', cuts: span('cut-1', 'cut-4b'), shapeAdapter: false },
  { name: 'PerProviderShapeAdapter', cuts: span('cut-3a', 'cut-4b'), shapeAdapter: true },
  { name: 'CatalogMergeAdapter', cuts: span('cut-3a', 'cut-4b'), shapeAdapter: true }
]

/** The listing as the releases up to 4a shipped it: today's listing plus the retired bridges. */
export const ADAPTERS_AS_SHIPPED: readonly LegacyBridgeAdapter[] = [
  ...LEGACY_BRIDGE_ADAPTERS,
  ...RETIRED_BRIDGE_ADAPTERS
]
