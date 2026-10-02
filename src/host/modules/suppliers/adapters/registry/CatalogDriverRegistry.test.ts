import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../../kernel/domain/errors'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import { createSupplierCatalogue } from '../../application/catalogue'
import { createInstallDetection } from '../../application/detection'
import { FAIL_CLOSED_CAPABILITIES } from '../../domain/capabilities'
import type { CatalogRecord, DriverTransport, ProviderProfile } from '../../domain/profile'
import { FakeInstallResolver } from '../../ports/fakes/FakeInstallResolver'
import { SimulatedDriver } from '../drivers/simulated/SimulatedDriver'
import { CatalogDriverRegistry } from './CatalogDriverRegistry'

const clock = new FakeClock()
const scheduler = new FakeScheduler(clock)

function record(id: string, overrides: Partial<ProviderProfile> = {}): CatalogRecord {
  return {
    profile: {
      id,
      label: id,
      binaries: [],
      models: [],
      efforts: [],
      permissionModes: [],
      drivers: ['acp'],
      publicLaunch: 'enabled',
      ...overrides
    },
    ceiling: { ...FAIL_CLOSED_CAPABILITIES, observe: true }
  }
}

function driverFor(source: CatalogRecord, transport: DriverTransport): SimulatedDriver {
  return new SimulatedDriver({
    profile: source.profile,
    transport,
    capabilities: source.ceiling,
    seed: `${source.profile.id}:${transport}`,
    clock,
    scheduler
  })
}

describe('DriverRegistry', () => {
  it("[ADR-009] drivers(id) returns the profile's transports in preference order", () => {
    const alpha = record('alpha', { drivers: ['http-server', 'acp', 'stdio-raw'] })
    const beta = record('beta', { drivers: ['ndjson'] })
    const registry = new CatalogDriverRegistry({
      catalogIds: ['alpha', 'beta'],
      records: [alpha, beta],
      drivers: [
        driverFor(alpha, 'acp'),
        driverFor(beta, 'ndjson'),
        driverFor(alpha, 'http-server')
      ],
      publicBuild: false
    })

    expect(registry.drivers('alpha').map((d) => d.transport)).toEqual(['http-server', 'acp'])
    expect(registry.drivers('beta').map((d) => d.transport)).toEqual(['ndjson'])
    expect(registry.drivers('not-in-catalog')).toEqual([])
  })

  it('[ADR-009] a profile id missing from the catalog id list is refused at construction', () => {
    const build = (): CatalogDriverRegistry =>
      new CatalogDriverRegistry({
        catalogIds: ['alpha'],
        records: [record('alpha'), record('stowaway')],
        drivers: [],
        publicBuild: false
      })

    expect(build).toThrow(HostInvariantError)
    expect(build).toThrow(/stowaway/)
    // One record per id: a second record would make the catalogue and the registry disagree.
    expect(
      () =>
        new CatalogDriverRegistry({
          catalogIds: ['alpha'],
          records: [record('alpha'), record('alpha')],
          drivers: [],
          publicBuild: false
        })
    ).toThrow(HostInvariantError)
  })

  it('[ADR-009] a driver for a transport its profile does not list is refused at construction', () => {
    const alpha = record('alpha', { drivers: ['acp'] })
    expect(
      () =>
        new CatalogDriverRegistry({
          catalogIds: ['alpha'],
          records: [alpha],
          drivers: [driverFor(alpha, 'ndjson')],
          publicBuild: false
        })
    ).toThrow(HostInvariantError)
  })

  it('[ADR-009] in a public build a gated provider is present in the catalogue but absent from launch surfaces', () => {
    const gated = record('gated-one', { publicLaunch: 'gated', drivers: ['ndjson'] })
    const open = record('open-one', { drivers: ['acp'] })
    const records = [gated, open]
    const drivers = [driverFor(gated, 'ndjson'), driverFor(open, 'acp')]
    const catalogIds = ['gated-one', 'open-one']

    const publicRegistry = new CatalogDriverRegistry({
      catalogIds,
      records,
      drivers,
      publicBuild: true
    })
    const devRegistry = new CatalogDriverRegistry({
      catalogIds,
      records,
      drivers,
      publicBuild: false
    })
    const catalogue = createSupplierCatalogue({
      records,
      publicBuild: true,
      detection: createInstallDetection({
        resolver: new FakeInstallResolver(),
        fs: new FakeFs(),
        scheduler: new FakeScheduler(new FakeClock())
      })
    })

    expect(publicRegistry.drivers('gated-one')).toEqual([])
    expect(publicRegistry.drivers('open-one').map((d) => d.transport)).toEqual(['acp'])
    expect(catalogue.entry('gated-one')).toMatchObject({
      providerId: 'gated-one',
      publicLaunch: 'gated'
    })
    expect(catalogue.capabilities('gated-one').observe).toBe(true)
    // Development builds keep it launchable, so its driver stays tested (ADR-009 D6).
    expect(devRegistry.drivers('gated-one').map((d) => d.transport)).toEqual(['ndjson'])
  })
})
