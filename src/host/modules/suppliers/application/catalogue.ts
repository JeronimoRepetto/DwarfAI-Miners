// The suppliers driving port `SupplierCatalogueQueries` (05 §3.4, 16 §4.4), skeleton: `entry(id)`
// and `capabilities(id)` over the catalog records, ceiling only. Installed detection (ISSUE-146),
// the capability merge, probe and integration gate (ISSUE-147) and `launchable()` (ISSUE-163) come
// later. Every answer is the record's own data: no provider id is special (INV-40, R12).
import type { IntegrationId, ProviderId } from '../../../kernel/domain/values'
import { FAIL_CLOSED_CAPABILITIES, type ProviderCapabilities } from '../domain/capabilities'
import type { CatalogRecord } from '../domain/profile'

/** 06 §0.2 `SupplierEntry` (entity, identity `providerId`). */
export interface SupplierEntry {
  providerId: ProviderId
  label: string
  models: string[]
  efforts: string[]
  permissionModes: string[]
  installed: boolean
  publicLaunch: 'enabled' | 'gated'
  answerChannel: 'available' | 'gated-off' | 'none'
  gatingIntegration?: IntegrationId
}

// 05 §3.4 driving ports.
export interface SupplierCatalogueQueries {
  launchable(): Promise<SupplierEntry[]> // installed, launch-enabled (Antigravity launch gated, OQ-15)
  entry(id: ProviderId): SupplierEntry | null // models, efforts, permission modes it can honor (OQ-05)
  capabilities(id: ProviderId): ProviderCapabilities
}

/** The part of `SupplierCatalogueQueries` this skeleton answers (`launchable`: ISSUE-163). */
export type SupplierCatalogueSkeleton = Pick<SupplierCatalogueQueries, 'entry' | 'capabilities'>

export interface SupplierCatalogueDeps {
  /** The records of this build (`recordsForBuild`); "Other…" is never one of them (INV-43). */
  readonly records: readonly CatalogRecord[]
}

export function createSupplierCatalogue(deps: SupplierCatalogueDeps): SupplierCatalogueSkeleton {
  const byId = new Map<ProviderId, CatalogRecord>()
  for (const record of deps.records) byId.set(record.profile.id, record)

  return {
    entry(id) {
      const record = byId.get(id)
      return record === undefined ? null : toEntry(record)
    },
    capabilities(id) {
      const record = byId.get(id)
      return structuredClone(record === undefined ? FAIL_CLOSED_CAPABILITIES : record.ceiling)
    }
  }
}

/**
 * The entry a record yields. `installed` stays false until detection exists (ISSUE-146), the
 * fail-closed answer. `answerChannel`: a gated entry is `gated-off` until the integration gate is
 * read (ISSUE-147); otherwise `available` iff the ceiling can carry an answer.
 */
function toEntry(record: CatalogRecord): SupplierEntry {
  const { profile, ceiling } = record
  const gate = profile.answerChannelGate
  const canAnswer = ceiling.permission === 'interactive' || ceiling.question !== 'none'
  return {
    providerId: profile.id,
    label: profile.label,
    models: profile.models.map((model) => model.id),
    efforts: [...profile.efforts],
    permissionModes: [...profile.permissionModes],
    installed: false,
    publicLaunch: profile.publicLaunch,
    answerChannel: gate !== undefined ? 'gated-off' : canAnswer ? 'available' : 'none',
    ...(gate !== undefined ? { gatingIntegration: gate } : {})
  }
}
