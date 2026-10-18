// ADR-009 D6 (PO #82; 15 §4.8 "Public builds"): the Antigravity profile is `publicLaunch: 'gated'`.
// In a public build the registry attaches no Antigravity driver and the catalogue lists no
// Antigravity entry as launchable, so it is on no launch surface: the Add panel chip, the Jev
// candidates and the default provider list all read `launchable()` (the Jev router's
// `RoutingCatalogSource` is that call), and delegated workers launch through the same registry.
// Its catalogue entry stays, and its sessions are observed by module observation's adapter
// (15 §5, row A2). In a development build it is launchable through this driver. The gate is the
// one build flag, read by the catalogue and the registry, never a provider-id branch (R12).
import { describe, expect, it } from 'vitest'
import type { HostEpoch, ProviderId } from '../../../../../kernel/domain/values'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import { RecordingEventBus } from '../../../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../../../kernel/fakes/SequenceIdGenerator'
import { createSupplierCatalogue } from '../../../application/catalogue'
import { createInstallDetection } from '../../../application/detection'
import { createCapabilityProbing } from '../../../application/probe'
import type { SuppliersEvent } from '../../../domain/events'
import { recordsForBuild, type CatalogRecord } from '../../../domain/profile'
import { FakeInstallResolver } from '../../../ports/fakes/FakeInstallResolver'
import { FakeIntegrationGateReader } from '../../../ports/fakes/FakeIntegrationGateReader'
import { InMemoryCapabilityRecordStore } from '../../../ports/fakes/InMemoryCapabilityRecordStore'
import { RecordingSpawn } from '../../../testing/recordingSpawn'
import { CATALOG_RECORDS } from '../../catalog/profiles'
import { CatalogDriverRegistry } from '../../registry/CatalogDriverRegistry'
import { AntigravityNdjsonDriver } from './AntigravityNdjsonDriver'

const ANTIGRAVITY = CATALOG_RECORDS.find(
  (record) => record.profile.id === 'antigravity'
) as CatalogRecord
const ID = ANTIGRAVITY.profile.id as ProviderId

/** The option lines of `agy --help` the probe reads (agy 1.4.2, 2026-10-18). */
const HELP = [
  'Usage of agy:',
  '  --conversation                  Resume a previous conversation by ID',
  '  --input-format                  Input format for print mode (text, stream-json). stream-json reads one NDJSON message per line from stdin and runs a turn for each; it requires --output-format stream-json (default text)',
  '  --output-format                 Output format for print mode (text, json, stream-json) (default text)',
  ''
].join('\n')

function build(publicBuild: boolean) {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const files = new FakeFs()
  files.addFile('/opt/tools/agy', '#!/bin/sh\n', 1_000)
  const resolver = new FakeInstallResolver({ scheduler })
  resolver.install('agy', { path: '/opt/tools/agy', version: '1.4.2' })
  const detection = createInstallDetection({ resolver, fs: files, scheduler })
  // Every spawn is an `agy --help` that prints the help and exits 0.
  const processControl = new RecordingSpawn({
    clock,
    scheduler,
    decide: () => ({ kind: 'exit', afterMs: 0, code: 0, stdout: HELP })
  })
  const records = recordsForBuild(CATALOG_RECORDS, { publicBuild })
  const driver = new AntigravityNdjsonDriver({
    record: ANTIGRAVITY,
    detection,
    processControl,
    clock,
    scheduler,
    loginEnv: { PATH: '/usr/bin', HOME: '/home/j' },
    home: '/home/j',
    platform: 'linux',
    redact: (text) => text
  })
  const registry = new CatalogDriverRegistry({
    // host/main hands over CATALOG_PROVIDER_IDS (R9); the records' own ids stand in for it here.
    catalogIds: CATALOG_RECORDS.map((record) => record.profile.id),
    records,
    drivers: [driver],
    publicBuild
  })
  const probing = createCapabilityProbing({
    registry,
    store: new InMemoryCapabilityRecordStore(),
    clock,
    scheduler,
    bus: new RecordingEventBus<SuppliersEvent>(),
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-1' as HostEpoch
  })
  const catalogue = createSupplierCatalogue({
    records,
    publicBuild,
    detection,
    probing,
    gate: new FakeIntegrationGateReader(),
    scheduler
  })
  /** Settles a call that waits on fake-time tasks (the help probe's exit), one tick at a time. */
  const drive = async <T>(call: Promise<T>): Promise<T> => {
    let done = false
    void call.finally(() => {
      done = true
    })
    for (let tick = 0; tick < 100 && !done; tick++) {
      for (let round = 0; round < 20; round++) await Promise.resolve()
      clock.advance(1)
    }
    return call
  }
  return { catalogue, registry, driver, processControl, drive }
}

describe('Antigravity in a public build (ADR-009 D6)', () => {
  it('[ADR-009] in a public build Antigravity is absent from launchable, Jev candidates, the default provider list and delegated workers, and still observed', async () => {
    const { catalogue, registry, processControl, drive } = build(true)
    const launchable = await drive(catalogue.launchable())
    expect(launchable.map((entry) => entry.providerId)).not.toContain(ID)
    // Delegated workers and every other launch take their driver from the registry: none.
    expect(registry.drivers(ID)).toEqual([])
    // Nothing was probed or launched: no driver ran agy at all.
    expect(processControl.spawns).toEqual([])
    // Still a catalogue entry (gated, not even detected for launch): observed sessions keep their
    // supplier.
    expect(catalogue.entry(ID)).toMatchObject({ providerId: ID, publicLaunch: 'gated' })
  })

  it('[ADR-009] in a development build Antigravity is launchable through this driver', async () => {
    const { catalogue, registry, driver, processControl, drive } = build(false)
    const launchable = await drive(catalogue.launchable())
    expect(launchable.map((entry) => entry.providerId)).toContain(ID)
    expect(registry.drivers(ID)).toEqual([driver])
    expect(processControl.spawns.map((spawn) => [spawn.executable, ...spawn.args])).toEqual([
      ['/opt/tools/agy', '--help']
    ])
    expect(catalogue.capabilities(ID)).toMatchObject({
      launch: true,
      resume: 'cli-flag',
      permission: 'none'
    })
  })
})
