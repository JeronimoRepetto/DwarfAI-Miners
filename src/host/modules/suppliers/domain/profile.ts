// The catalog data of the suppliers module: ADR-009 D1 (profile and transport, copied field for
// field; ADR-009 is the owner and wins on any difference), the 15 §1.2 catalog types and ADR-011
// item 1's permission-mode types. Pure: no I/O, no clock read (05 §2.2, R1).
import type { IntegrationId, ProviderId } from '../../../kernel/domain/values'
import type { ProviderCapabilities } from './capabilities'

export type { ProviderId }

// ---------- ADR-009 D1 ----------

export interface ProviderProfile {
  // pure data, serializable to the UI
  id: ProviderId
  label: string // plain-text name (ADR-008 trademarks)
  binaries: string[] // executable names resolved from the user's install
  models: ModelEntry[]
  efforts: string[]
  permissionModes: PermissionModeId[] // ceiling; filtered by capabilities (ADR-011)
  drivers: DriverTransport[] // preference order, first verified wins
  publicLaunch: 'enabled' | 'gated' // 'gated' = launch disabled in public builds (ADR-008 item 6)
  answerChannelGate?: IntegrationId // integration whose state gates the answer channel (ADR-011 item 7);
  // absent = not gated; the only owner of this catalog fact (15 §2.1)
}

export type DriverTransport =
  'acp' | 'agent-sdk' | 'stream-json' | 'app-server-rpc' | 'http-server' | 'ndjson' | 'stdio-raw'

export type SessionOwnership = 'owned' | 'observed' // replaces Detached / Held / Hosted (AQ-28)

// ---------- 15 §1.2 catalog data (ADR-009 D1 fields) ----------

export interface ModelEntry {
  id: string // the provider's own model id, passed to the CLI/SDK unchanged
  label: string // plain text (ADR-008 item 7)
  efforts: readonly string[] // COMPLETE and ORDERED low → high (ADR-028 Consequences); [] = no effort flag
  isDefault?: boolean
}

export interface ProviderPolicy {
  // PermissionModeSpec.providerArgs (ADR-011 item 1): how a driver enforces a mode
  argv?: readonly string[] // extra CLI flags (never a flag of ADR-008 item 3's forbidden list)
  options?: Readonly<Record<string, string | boolean>> // SDK / protocol options (e.g. Codex approval policy)
  disableQuestionTools?: boolean // ADR-011 item 2 "questions" column
}

// ---------- ADR-011 item 1 ----------

/** Owner: ADR-011 item 1: catalog data; "ask-first" is the interactive mode's id. */
export type PermissionModeId = string

/** Owner: ADR-011 item 1. */
export interface PermissionModeSpec {
  id: PermissionModeId
  label: string // copy from the design
  needs: 'interactive' | 'policy-only' // what the provider must support to honor it
  providerArgs: ProviderPolicy // how the driver enforces it (item 3)
}

/** One provider's permission-mode data (ADR-011 item 1): the spec of each mode id it lists. */
export interface PermissionModeCatalog {
  readonly specs: readonly PermissionModeSpec[]
  /** A verified non-interactive deny policy (15 §2.8) lets `permission: 'none'` offer policy-only modes. */
  readonly denyPolicyVerified: boolean
}

// ---------- the catalog record (package gap, resolved in development) ----------

/**
 * One catalog entry as the catalog adapter declares it: the ADR-009 D1 profile plus the
 * provider's capability ceiling (ADR-009 D2 "each profile declares a ceiling"; 15 §0 "ceiling =
 * catalog data per provider"). `ProviderProfile` is frozen and has no ceiling field, so the
 * ceiling travels beside it. `developmentOnly` keeps an entry out of public builds as data,
 * never as a provider-id branch (15 §4.12, R12).
 */
export interface CatalogRecord {
  readonly profile: ProviderProfile
  readonly ceiling: ProviderCapabilities
  readonly developmentOnly?: boolean
  /**
   * The specs behind `profile.permissionModes` (ADR-011 item 1). `ProviderProfile` is frozen and
   * lists mode ids only, so the specs travel beside it, like the ceiling. Absent: no mode can be
   * offered (fail closed).
   */
  readonly modes?: PermissionModeCatalog
}

/** The records a build carries: a public build drops every development-only record. */
export function recordsForBuild(
  records: readonly CatalogRecord[],
  build: { publicBuild: boolean }
): readonly CatalogRecord[] {
  return build.publicBuild ? records.filter((record) => record.developmentOnly !== true) : records
}
