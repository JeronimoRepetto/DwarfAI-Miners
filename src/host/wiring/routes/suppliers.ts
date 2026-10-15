// The suppliers module's transport route (05 §4; 16 §8.2):
//
// - `serveSuppliers`, run by the composition root before the boot binds the endpoint, so every
//   `hello.ok` lists B-M37 `suppliers.launchable` (14 §1.3). Until boot step 4 wired the suppliers
//   module the Host is not `ready`, so a call answers HOST_NOT_READY before reaching it; a call
//   that still did would be a wiring defect.
// - `bind`, run by boot step 4 right after `wireSuppliers`, over `launchableSource`: the
//   catalogue's `launchable()` and each provider's catalog models (ADR-009 D1
//   `ProviderProfile.models`), read from the profile of its driver. A launchable entry always has
//   one: it is launch-enabled only when a driver of its profile probed `launch` (15 §2.1).
import { HostInvariantError } from '../../kernel/domain/errors'
import type { ProviderDriver, ProviderId, SupplierCatalogueQueries } from '../../modules/suppliers'
import type { Dispatcher } from '../../transport/dispatcher'
import {
  registerSuppliersLaunchable,
  type SuppliersLaunchableDeps
} from '../../transport/methods/suppliersLaunchable'

export interface SuppliersServeDeps {
  dispatcher: Dispatcher
}

export interface ServedSuppliers {
  /** Binds B-M37 to the wired suppliers module (boot step 4); once. */
  bind(deps: SuppliersLaunchableDeps): void
}

/** What B-M37 reads of the suppliers module (`Suppliers` satisfies it). */
export interface LaunchableSuppliers {
  catalogue: Pick<SupplierCatalogueQueries, 'launchable'>
  registry: { drivers(id: ProviderId): readonly Pick<ProviderDriver, 'profile'>[] }
}

/** B-M37's sources over the suppliers module: its catalogue and its drivers' catalog models. */
export function launchableSource(suppliers: LaunchableSuppliers): SuppliersLaunchableDeps {
  return {
    catalogue: suppliers.catalogue,
    models: (id) => suppliers.registry.drivers(id)[0]?.profile.models ?? []
  }
}

export function serveSuppliers(serve: SuppliersServeDeps): ServedSuppliers {
  let bound: SuppliersLaunchableDeps | undefined
  const current = (): SuppliersLaunchableDeps => {
    if (bound === undefined) throw new HostInvariantError('suppliers is served from boot step 4 on')
    return bound
  }
  registerSuppliersLaunchable(serve.dispatcher, {
    catalogue: { launchable: () => current().catalogue.launchable() },
    models: (id) => current().models(id)
  })
  return {
    bind: (deps) => {
      if (bound !== undefined) throw new HostInvariantError('suppliers is bound once')
      bound = deps
    }
  }
}
