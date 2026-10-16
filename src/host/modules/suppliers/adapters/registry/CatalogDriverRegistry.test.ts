import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../../kernel/domain/errors'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import { createSupplierCatalogue } from '../../application/catalogue'
import { createInstallDetection } from '../../application/detection'
import { createCapabilityProbing } from '../../application/probe'
import { ceilingOf, FAIL_CLOSED_CAPABILITIES } from '../../domain/capabilities'
import type { CatalogRecord, DriverTransport, ProviderProfile } from '../../domain/profile'
import { FakeInstallResolver } from '../../ports/fakes/FakeInstallResolver'
import { FakeIntegrationGateReader } from '../../ports/fakes/FakeIntegrationGateReader'
import { InMemoryCapabilityRecordStore } from '../../ports/fakes/InMemoryCapabilityRecordStore'
import { RecordingEventBus } from '../../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import type { SuppliersEvent } from '../../domain/events'
import { SimulatedDriver } from '../drivers/simulated/SimulatedDriver'
import { FakeProcessControl } from '../../../../kernel/fakes/FakeProcessControl'
import { HostedCommandDriver } from '../drivers/hosted-command/HostedCommandDriver'
import { HOSTED_COMMAND_PROFILE } from '../drivers/hosted-command/profile'
import { preferredRow } from '../../testing/ceilingRow'
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
    ceiling: ceilingOf({ ...FAIL_CLOSED_CAPABILITIES, observe: true })
  }
}

function driverFor(source: CatalogRecord, transport: DriverTransport): SimulatedDriver {
  return new SimulatedDriver({
    profile: source.profile,
    transport,
    capabilities: preferredRow(source.ceiling),
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

  it('[ADR-009] in a public build a gated provider is present in the catalogue but absent from launch surfaces', async () => {
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
      }),
      // Amended for ISSUE-147: the catalogue also takes probing (over the public registry), the
      // integration gate and a scheduler.
      probing: createCapabilityProbing({
        registry: publicRegistry,
        store: new InMemoryCapabilityRecordStore(),
        clock,
        scheduler,
        bus: new RecordingEventBus<SuppliersEvent>(),
        ids: new SequenceIdGenerator(),
        hostEpoch: 'epoch-1'
      }),
      gate: new FakeIntegrationGateReader(),
      scheduler
    })

    expect(publicRegistry.drivers('gated-one')).toEqual([])
    expect(publicRegistry.drivers('open-one').map((d) => d.transport)).toEqual(['acp'])
    expect(catalogue.entry('gated-one')).toMatchObject({
      providerId: 'gated-one',
      publicLaunch: 'gated'
    })
    // Amended for ISSUE-147: with no driver in a public build nothing can probe it, so its
    // capabilities carry no evidence and fail closed (ADR-009 D2, D6; INV-44); it stays known as
    // catalogue data above and is on no launch surface. Was: `observe` read from the ceiling (true).
    expect(catalogue.capabilities('gated-one').launch).toBe(false)
    expect(await catalogue.launchable()).toEqual([])
    // Development builds keep it launchable, so its driver stays tested (ADR-009 D6).
    expect(devRegistry.drivers('gated-one').map((d) => d.transport)).toEqual(['ndjson'])
  })
})

// ISSUE-165 (INV-43; 15 §4.11, §3 row H1): the "Other…" driver is served outside the catalog. It is a
// launch way, not a supplier: no catalog record names it, so it is never in the catalogue, never
// launchable and never a Default provider; the registry serves it by its profile so the
// SessionStarter bridge and the live-session tracking reach it like any driver.
describe('DriverRegistry and the "Other…" driver (ISSUE-165)', () => {
  function hostedDriver(): HostedCommandDriver {
    return new HostedCommandDriver({
      processControl: new FakeProcessControl({ clock }),
      clock,
      scheduler,
      loginEnv: {},
      platform: 'linux',
      redact: (text) => text
    })
  }

  it('[INV-43, US-OBS-007.AC05] the one "Other…" driver is served outside the catalog, and the catalog ids stay as they were', () => {
    const alpha = record('alpha')
    const other = hostedDriver()
    const build = (): CatalogDriverRegistry =>
      new CatalogDriverRegistry({
        catalogIds: ['alpha'],
        records: [alpha],
        drivers: [driverFor(alpha, 'acp'), other],
        publicBuild: true
      })

    expect(build).not.toThrow()
    const registry = build()
    expect(registry.drivers(HOSTED_COMMAND_PROFILE.id)).toEqual([other])
    expect(registry.drivers('alpha').map((d) => d.transport)).toEqual(['acp'])
  })

  it('[INV-43, ADR-009] any other driver outside the catalog is still refused, a look-alike of the "Other…" profile included', () => {
    const alpha = record('alpha')
    const lookAlike = record(HOSTED_COMMAND_PROFILE.id, { drivers: ['stdio-raw'] })
    const wrongTransport = new SimulatedDriver({
      profile: HOSTED_COMMAND_PROFILE,
      transport: 'acp',
      capabilities: preferredRow(alpha.ceiling),
      seed: 'other:acp',
      clock,
      scheduler
    })
    const stranger = record('stranger')
    for (const driver of [
      driverFor(lookAlike, 'stdio-raw'),
      wrongTransport,
      driverFor(stranger, 'acp')
    ]) {
      expect(
        () =>
          new CatalogDriverRegistry({
            catalogIds: ['alpha'],
            records: [alpha],
            drivers: [driver],
            publicBuild: false
          })
      ).toThrow(HostInvariantError)
    }
  })
})
