// The jev `RoutingCatalogSource` bridge (16 §4.9 "bridge → suppliers"; 05 §3.9, §4): the providers
// Jev may choose among are exactly what `SupplierCatalogueQueries.launchable()` answers at this step
// (21 §2 cut 3 "Let Jev choose": no widening adapter, OI-21-4 option 2). The bridge neither filters
// nor widens that list; a provider installed but not launchable never becomes a criterion
// (US-LAUNCH-003.AC11).
import type { RoutingCatalogSource } from '../../modules/jev'
import type { SupplierCatalogueQueries } from '../../modules/suppliers'

export function routingCatalogSource(
  catalogue: Pick<SupplierCatalogueQueries, 'launchable'>
): RoutingCatalogSource {
  return { launchable: () => catalogue.launchable() }
}
