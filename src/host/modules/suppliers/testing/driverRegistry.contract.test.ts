import { CatalogDriverRegistry } from '../adapters/registry/CatalogDriverRegistry'
import { FakeDriverRegistry } from '../ports/fakes/FakeDriverRegistry'
import { runDriverRegistryContract } from './driverRegistry.contract'

runDriverRegistryContract(
  'FakeDriverRegistry',
  (_records, drivers) => new FakeDriverRegistry(drivers)
)

runDriverRegistryContract(
  'CatalogDriverRegistry',
  (records, drivers) =>
    new CatalogDriverRegistry({
      catalogIds: records.map((r) => r.profile.id),
      records,
      drivers,
      publicBuild: false
    })
)
