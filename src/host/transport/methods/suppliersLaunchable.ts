// B-M37 `suppliers.launchable` (14 §2.3, §3.4, §3.6 `SupplierEntryView`, frozen; 14 §4.1): the
// suppliers the Add panel can launch, asked on every open. UI main's A-36 relays it (the route
// switch of cut 3a, later: ISSUE-001). The suppliers route registers it
// (wiring/routes/suppliers.ts `serveSuppliers`).
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - A query (14 §1.6): no requestId, no effect, no frame. The catalogue is not in the snapshot.
// - The params are the contract's strict() schema (ADR-019): `{ refresh?: boolean }`; any other key
//   or type is INVALID_PARAMS before the handler runs.
// - Detection: every call asks `SupplierCatalogueQueries.launchable()`, which re-checks the
//   installed CLIs within the 500 ms budget (ADR-009 D5; 16 §4.4, INV-41, INV-42), so every call,
//   `{ refresh: true }` included, is a rescan. Nothing is cached here: a CLI removed since the last
//   open is absent from the next answer. (Package gap: the 16 §4.4 port takes no refresh argument,
//   so `refresh` has nothing more to force than the per-call re-check; recorded in ISSUE-163.)
// - Each `SupplierEntry` crosses as `SupplierEntryView` (mappers/supplierEntryView.ts).
import { HOST_METHOD_SCHEMAS, type SupplierEntryView } from '@dwarfai/contracts'
import type { ModelEntry, ProviderId, SupplierCatalogueQueries } from '../../modules/suppliers'
import type { Dispatcher } from '../dispatcher'
import { toSupplierEntryView } from '../mappers/supplierEntryView'
import { METHOD_ROLES } from '../roles'

export interface SuppliersLaunchableDeps {
  catalogue: Pick<SupplierCatalogueQueries, 'launchable'>
  /** The catalog `ModelEntry` list of a provider (ADR-009 D1 `ProviderProfile.models`). */
  models(id: ProviderId): readonly ModelEntry[]
}

/** Serves `suppliers.launchable` (B-M37) on `dispatcher`. */
export function registerSuppliersLaunchable(
  dispatcher: Dispatcher,
  deps: SuppliersLaunchableDeps
): void {
  dispatcher.register(
    'suppliers.launchable',
    HOST_METHOD_SCHEMAS['suppliers.launchable'].params,
    METHOD_ROLES['suppliers.launchable'] ?? [],
    async (): Promise<SupplierEntryView[]> =>
      (await deps.catalogue.launchable()).map((entry) =>
        toSupplierEntryView(entry, deps.models(entry.providerId))
      )
  )
}
