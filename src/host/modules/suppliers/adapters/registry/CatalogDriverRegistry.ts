// The `DriverRegistry` adapter (16 §4.4): one ProviderDriver per catalog entry and transport, in
// the profile's preference order (ADR-009 D4). Every profile id must be in the catalog id list the
// composition root hands over (`CATALOG_PROVIDER_IDS`, ISSUE-009; R9 keeps `contracts` out of the
// module), so the catalog and R12's literal list never drift apart. In a public build a
// `publicLaunch: 'gated'` provider has no driver: it stays in the catalogue as observed-only data
// and is offered on no launch surface (ADR-009 D5–D6: "a provider left with no driver is
// observe-only"). The gate is the one build flag, read here, never a provider-id branch.
//
// Candidate decision (21 §6): `src/main/providers/registry.ts` is replaced, not kept — it is a
// table of observation-side `Provider` factories keyed by the closed `DwarfProvider` union, with
// no driver, no transport and no preference order, so it cannot answer `drivers(id)`.
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { ProviderId } from '../../../../kernel/domain/values'
import type { CatalogRecord } from '../../domain/profile'
import type { DriverRegistry } from '../../ports/driverRegistry'
import type { ProviderDriver } from '../../ports/providerDriver'

export interface CatalogDriverRegistryDeps {
  /** The one catalog id list (`CATALOG_PROVIDER_IDS`), passed in by `host/main.ts` (R9). */
  readonly catalogIds: readonly ProviderId[]
  /** The records of this build (`recordsForBuild`). */
  readonly records: readonly CatalogRecord[]
  /** The drivers this build attaches, in any order. */
  readonly drivers: readonly ProviderDriver[]
  /** The build-time flag of ADR-009 D6. */
  readonly publicBuild: boolean
}

export class CatalogDriverRegistry implements DriverRegistry {
  private readonly byId = new Map<ProviderId, readonly ProviderDriver[]>()

  constructor(deps: CatalogDriverRegistryDeps) {
    const allowed = new Set(deps.catalogIds)
    const profiles = new Map<ProviderId, CatalogRecord['profile']>()
    for (const { profile } of deps.records) {
      if (!allowed.has(profile.id)) {
        throw new HostInvariantError(`catalog profile "${profile.id}" is not a catalog provider id`)
      }
      if (profiles.has(profile.id)) {
        throw new HostInvariantError(`catalog profile "${profile.id}" is listed twice`)
      }
      profiles.set(profile.id, profile)
    }
    for (const driver of deps.drivers) {
      const profile = profiles.get(driver.profile.id)
      if (profile === undefined || !profile.drivers.includes(driver.transport)) {
        throw new HostInvariantError(
          `driver "${driver.profile.id}/${driver.transport}" matches no transport of a catalog profile`
        )
      }
    }
    for (const profile of profiles.values()) {
      const launchable = !(deps.publicBuild && profile.publicLaunch === 'gated')
      const ordered = launchable
        ? profile.drivers.flatMap((transport) =>
            deps.drivers.filter((d) => d.profile.id === profile.id && d.transport === transport)
          )
        : []
      this.byId.set(profile.id, Object.freeze(ordered))
    }
  }

  drivers(id: ProviderId): readonly ProviderDriver[] {
    return this.byId.get(id) ?? []
  }
}
