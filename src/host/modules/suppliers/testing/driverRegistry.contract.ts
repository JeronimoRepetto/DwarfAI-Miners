// `runDriverRegistryContract` (16 §2.8, §4.4): what every `DriverRegistry` — the
// `CatalogDriverRegistry` adapter and the `FakeDriverRegistry` double — must do: `drivers(id)` in
// the profile's preference order (ADR-009 D4), and nothing for an id it does not hold.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { SimulatedDriver } from '../adapters/drivers/simulated/SimulatedDriver'
import { FAIL_CLOSED_CAPABILITIES } from '../domain/capabilities'
import type { CatalogRecord, DriverTransport } from '../domain/profile'
import type { DriverRegistry } from '../ports/driverRegistry'
import type { ProviderDriver } from '../ports/providerDriver'

export type MakeDriverRegistry = (
  records: readonly CatalogRecord[],
  drivers: readonly ProviderDriver[]
) => DriverRegistry

function record(id: string, drivers: DriverTransport[]): CatalogRecord {
  return {
    profile: {
      id,
      label: id,
      binaries: [],
      models: [],
      efforts: [],
      permissionModes: [],
      drivers,
      publicLaunch: 'enabled'
    },
    ceiling: FAIL_CLOSED_CAPABILITIES
  }
}

export function runDriverRegistryContract(name: string, make: MakeDriverRegistry): void {
  describe(`DriverRegistry contract: ${name}`, () => {
    const clock = new FakeClock()
    const scheduler = new FakeScheduler(clock)
    const simulated = (source: CatalogRecord, transport: DriverTransport): ProviderDriver =>
      new SimulatedDriver({
        profile: source.profile,
        transport,
        capabilities: source.ceiling,
        seed: transport,
        clock,
        scheduler
      })

    it('[ADR-009] drivers(id) follows the profile preference order, not the order drivers were given', () => {
      const first = record('first', ['app-server-rpc', 'acp'])
      const second = record('second', ['stream-json'])
      const registry = make(
        [first, second],
        [
          simulated(first, 'acp'),
          simulated(second, 'stream-json'),
          simulated(first, 'app-server-rpc')
        ]
      )

      expect(registry.drivers('first').map((d) => d.transport)).toEqual(['app-server-rpc', 'acp'])
      expect(registry.drivers('second').map((d) => d.transport)).toEqual(['stream-json'])
    })

    it('[ADR-009] drivers of an id the registry does not hold is empty', () => {
      const only = record('only', ['acp'])
      expect(make([only], [simulated(only, 'acp')]).drivers('absent')).toEqual([])
    })
  })
}
