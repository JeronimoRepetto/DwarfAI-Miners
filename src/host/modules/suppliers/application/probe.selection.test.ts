// layer: L1
// L1 (17 §1.1): the capability check's driver selection (ADR-009 D4, "first verified wins"; GitHub #1431) over two
// probe doubles of one provider, the FakeDriverRegistry, a FakeScheduler and the in-memory record store: no process,
// no disk.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { ceilingOf, FAIL_CLOSED_CAPABILITIES } from '../domain/capabilities'
import type { SuppliersEvent } from '../domain/events'
import type { CatalogRecord, DriverTransport } from '../domain/profile'
import { FakeDriverRegistry } from '../ports/fakes/FakeDriverRegistry'
import { FakeInstallResolver } from '../ports/fakes/FakeInstallResolver'
import { InMemoryCapabilityRecordStore } from '../ports/fakes/InMemoryCapabilityRecordStore'
import { preferredRow } from '../testing/ceilingRow'
import { ProbeTestDriver } from '../testing/ProbeTestDriver'
import { createInstallDetection } from './detection'
import { createCapabilityProbing } from './probe'

const clock = new FakeClock()
const scheduler = new FakeScheduler(clock)

const RECORD: CatalogRecord = {
  profile: {
    id: 'alpha',
    label: 'Alpha',
    binaries: [],
    models: [],
    efforts: [],
    permissionModes: [],
    drivers: ['http-server', 'acp'],
    publicLaunch: 'enabled'
  },
  ceiling: ceilingOf({ ...FAIL_CLOSED_CAPABILITIES, launch: true, observe: true })
}

const detection = createInstallDetection({
  resolver: new FakeInstallResolver(),
  fs: new FakeFs(),
  scheduler
})

/** A driver of RECORD (no CLI: installed by itself) on `transport` whose probe measures `launch`. */
function driver(transport: DriverTransport, launch: boolean): ProbeTestDriver {
  return new ProbeTestDriver({
    profile: RECORD.profile,
    transport,
    detection,
    probe: async () => ({ ...preferredRow(RECORD.ceiling), launch })
  })
}

function probing(drivers: readonly ProbeTestDriver[]) {
  return createCapabilityProbing({
    registry: new FakeDriverRegistry(drivers),
    store: new InMemoryCapabilityRecordStore(),
    clock,
    scheduler,
    bus: new RecordingEventBus<SuppliersEvent>(),
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-1431'
  })
}

describe('capability probing: the selected driver (ADR-009 D4)', () => {
  it('[ADR-009] the selected driver is the first, in preference order, whose probe verified launch', async () => {
    const server = driver('http-server', false)
    const acp = driver('acp', true)
    const probe = probing([server, acp])

    expect(probe.selectedDriver('alpha')).toBeNull()
    await probe.refresh('alpha')

    expect(probe.selectedDriver('alpha')).toBe(acp)
    expect(probe.selected('alpha')?.launch).toBe(true)
  })

  it('[ADR-009] with no driver verified, the selected driver is the first probed one, the one `selected` measured', async () => {
    const server = driver('http-server', false)
    const acp = driver('acp', false)
    const probe = probing([server, acp])

    await probe.refresh('alpha')

    expect(probe.selectedDriver('alpha')).toBe(server)
    expect(probe.selected('alpha')?.launch).toBe(false)
  })
})
