// A machine for the catalogue's L2 tests: the catalogue over catalog records, with the real
// installed detection over `FakeInstallResolver` and a recording `FakeFs`, one `ProbeTestDriver`
// per record transport (in the profile's preference order), the real capability probing over an
// `InMemoryCapabilityRecordStore`, a recording event bus and a `FakeIntegrationGateReader`.
// By default every driver measures exactly its record's ceiling.
import type { HostEpoch } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { createSupplierCatalogue } from '../application/catalogue'
import { createInstallDetection } from '../application/detection'
import { createCapabilityProbing } from '../application/probe'
import type { SuppliersEvent } from '../domain/events'
import type { CatalogRecord, DriverTransport } from '../domain/profile'
import { FakeDriverRegistry } from '../ports/fakes/FakeDriverRegistry'
import { FakeInstallResolver, type FakeInstall } from '../ports/fakes/FakeInstallResolver'
import { FakeIntegrationGateReader } from '../ports/fakes/FakeIntegrationGateReader'
import { InMemoryCapabilityRecordStore } from '../ports/fakes/InMemoryCapabilityRecordStore'
import { ProbeTestDriver, type ProbeScript } from './ProbeTestDriver'

export interface CatalogueMachineOptions {
  readonly publicBuild?: boolean
  /** The probe of one driver; default: it measures its record's ceiling. */
  readonly probe?: (record: CatalogRecord, transport: DriverTransport) => ProbeScript
}

/** One file-system call the catalogue made, by method and path. */
export interface FsCall {
  readonly method: string
  readonly path: unknown
}

export function catalogueMachine(
  records: readonly CatalogRecord[],
  options: CatalogueMachineOptions = {}
) {
  const clock = new FakeClock()
  const scheduler = new FakeScheduler(clock)
  const files = new FakeFs()
  const fsCalls: FsCall[] = []
  const fs = new Proxy(files, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        fsCalls.push({ method: String(key), path: args[0] })
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    }
  })
  const resolver = new FakeInstallResolver({ scheduler })
  const detection = createInstallDetection({ resolver, fs, scheduler })
  const store = new InMemoryCapabilityRecordStore()
  const bus = new RecordingEventBus<SuppliersEvent>()
  const gate = new FakeIntegrationGateReader()
  const drivers = records.flatMap((record) =>
    record.profile.drivers.map(
      (transport) =>
        new ProbeTestDriver({
          profile: record.profile,
          transport,
          detection,
          probe:
            options.probe?.(record, transport) ??
            (() => Promise.resolve(structuredClone(record.ceiling)))
        })
    )
  )
  const probing = createCapabilityProbing({
    registry: new FakeDriverRegistry(drivers),
    store,
    clock,
    scheduler,
    bus,
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-1' as HostEpoch
  })
  const catalogue = createSupplierCatalogue({
    records,
    publicBuild: options.publicBuild ?? false,
    detection,
    probing,
    gate,
    scheduler
  })

  /** Installs a CLI: the resolver finds it, and the file it names has this mtime. */
  const install = (
    binary: string,
    extra: Partial<FakeInstall> & { mtimeMs?: number } = {}
  ): void => {
    const { mtimeMs, ...rest } = extra
    const path = `/opt/tools/${binary}`
    files.addFile(path, '#!/bin/sh\n', mtimeMs ?? 1_000)
    resolver.install(binary, { path, version: '1.0.0', ...rest })
  }
  const ids = async (): Promise<string[]> =>
    (await catalogue.launchable()).map((entry) => entry.providerId)
  const driver = (id: string, transport: DriverTransport): ProbeTestDriver => {
    const found = drivers.find((d) => d.profile.id === id && d.transport === transport)
    if (found === undefined) throw new Error(`no driver ${id}/${transport}`)
    return found
  }
  return {
    clock,
    scheduler,
    fs: files,
    fsCalls,
    resolver,
    store,
    bus,
    gate,
    catalogue,
    install,
    ids,
    driver
  }
}

/** Lets the pending promise chains run without advancing the fake clock. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve()
}
