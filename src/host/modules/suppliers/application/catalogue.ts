// The suppliers driving port `SupplierCatalogueQueries` (05 §3.4, 16 §4.4) over the catalog
// records: `launchable()` lists the installed, launch-enabled entries only (INV-41; ADR-009 D5, D6),
// `entry(id)` and `capabilities(id)` answer the ceiling. The capability merge, probe and
// integration gate (ISSUE-147) and the Host method (ISSUE-163) come later. Every answer is the
// record's own data: no provider id is special (INV-40, R12).
import type { IntegrationId, ProviderId } from '../../../kernel/domain/values'
import { FAIL_CLOSED_CAPABILITIES, type ProviderCapabilities } from '../domain/capabilities'
import type { CatalogRecord } from '../domain/profile'
import type { InstallDetection } from './detection'

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

export interface SupplierCatalogueDeps {
  /** The records of this build (`recordsForBuild`); "Other…" is never one of them (INV-43). */
  readonly records: readonly CatalogRecord[]
  /** The build-time flag of ADR-009 D6: a public build offers no `publicLaunch: 'gated'` entry. */
  readonly publicBuild: boolean
  /** The one installed detection behind every `detect()` (ADR-009 D5). */
  readonly detection: InstallDetection
}

export function createSupplierCatalogue(deps: SupplierCatalogueDeps): SupplierCatalogueQueries {
  const byId = new Map<ProviderId, CatalogRecord>()
  for (const record of deps.records) byId.set(record.profile.id, record)

  /** `installDetection: 'none'` (the simulated provider) resolves no CLI: present by itself. */
  const isInstalled = async (record: CatalogRecord): Promise<boolean> =>
    record.ceiling.installDetection === 'none' ||
    (record.profile.binaries.length > 0 &&
      (await deps.detection.detect(record.profile.binaries)).kind === 'installed')

  /** What the last detection said, without checking again (`entry` is synchronous). */
  const installedNow = (record: CatalogRecord): boolean =>
    record.ceiling.installDetection === 'none' ||
    deps.detection.last(record.profile.binaries)?.kind === 'installed'

  return {
    // Re-checked on every call, that is on every Add-panel open (ADR-009 D5). A gated provider in a
    // public build and a provider whose CLI does not resolve are simply absent: no disabled entry,
    // no reason (US-RES-005.AC01-AC02). "Other…" is never a record, so never an entry (INV-43).
    async launchable() {
      const offered = deps.records.filter(
        (record) => !(deps.publicBuild && record.profile.publicLaunch === 'gated')
      )
      const installed = await Promise.all(offered.map((record) => isInstalled(record)))
      return offered
        .filter((_, at) => installed[at] === true)
        .map((record) => toEntry(record, true))
    },
    entry(id) {
      const record = byId.get(id)
      return record === undefined ? null : toEntry(record, installedNow(record))
    },
    capabilities(id) {
      const record = byId.get(id)
      return structuredClone(record === undefined ? FAIL_CLOSED_CAPABILITIES : record.ceiling)
    }
  }
}

/**
 * The entry a record yields, with `installed` as detection answered it. `answerChannel`: a gated entry is `gated-off` until the integration gate is
 * read (ISSUE-147); otherwise `available` iff the ceiling can carry an answer.
 */
function toEntry(record: CatalogRecord, installed: boolean): SupplierEntry {
  const { profile, ceiling } = record
  const gate = profile.answerChannelGate
  const canAnswer = ceiling.permission === 'interactive' || ceiling.question !== 'none'
  return {
    providerId: profile.id,
    label: profile.label,
    models: profile.models.map((model) => model.id),
    efforts: [...profile.efforts],
    permissionModes: [...profile.permissionModes],
    installed,
    publicLaunch: profile.publicLaunch,
    answerChannel: gate !== undefined ? 'gated-off' : canAnswer ? 'available' : 'none',
    ...(gate !== undefined ? { gatingIntegration: gate } : {})
  }
}
