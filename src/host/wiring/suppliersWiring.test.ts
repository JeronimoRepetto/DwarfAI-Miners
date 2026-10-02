// layer: L2
// The suppliers wiring's start-up detection (ADR-009 D5) runs unawaited at boot step 4: if it ever
// rejects, the rejection is logged (19 §9.1 `uncaught`, FM-001) and never reaches the process as an
// unhandled rejection, which would end the Host (ADR-002 D1, D7: the Host never exits on its own).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { FakeFs } from '../kernel/fakes/FakeFs'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../kernel/fakes/SequenceIdGenerator'
import type { HostEpoch } from '../kernel/domain/values'
import type { Scheduler } from '../kernel/ports/scheduler'
import type { SuppliersEvent } from '../modules/suppliers'
import { wireSuppliers } from './suppliersWiring'

describe('suppliers wiring start-up detection', () => {
  it('[FM-001] a start-up detection that rejects is logged and never ends the Host', async () => {
    const log = new RecordingDiagnosticsLog()
    const broken: Scheduler = {
      after: () => {
        throw new Error('scheduler unavailable')
      }
    }

    wireSuppliers({
      publicBuild: false,
      clock: new FakeClock(),
      scheduler: broken,
      ids: new SequenceIdGenerator(),
      fs: new FakeFs(),
      log,
      installResolver: { resolve: () => Promise.resolve(null) },
      capabilityRecords: { record: () => undefined, latest: () => null },
      bus: new RecordingEventBus<SuppliersEvent>(),
      hostEpoch: 'epoch-0159' as HostEpoch,
      simulatedSeed: 'seed'
    })
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(log.entries).toContainEqual(
      expect.objectContaining({ level: 'error', event: 'uncaught', subsystem: 'suppliers' })
    )
  })
})
