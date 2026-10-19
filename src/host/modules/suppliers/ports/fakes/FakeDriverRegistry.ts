// The `DriverRegistry` double (16 §4.4): holds the drivers a test hands it — `SimulatedDriver` in
// practice — and answers each id with that provider's drivers in its profile's preference order
// (ADR-009 D4). No catalog id check and no build flag: those are the adapter's. Passes
// runDriverRegistryContract.
import type { ProviderId } from '../../../../kernel/domain/values'
import type { DriverRegistry } from '../driverRegistry'
import type { ProviderDriver } from '../providerDriver'

export class FakeDriverRegistry implements DriverRegistry {
  constructor(private readonly held: readonly ProviderDriver[]) {}

  drivers(id: ProviderId): readonly ProviderDriver[] {
    const own = this.held.filter((driver) => driver.profile.id === id)
    const order = own[0]?.profile.drivers ?? []
    return order.flatMap((transport) => own.filter((driver) => driver.transport === transport))
  }
}
