// layer: L2
// The suppliers wiring's start-up detection (ADR-009 D5) runs unawaited at boot step 4: if it ever
// rejects, the rejection is logged (19 §9.1 `uncaught`, FM-001) and never reaches the process as an
// unhandled rejection, which would end the Host (ADR-002 D1, D7: the Host never exits on its own).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'
import { FakeFs } from '../kernel/fakes/FakeFs'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../kernel/fakes/SequenceIdGenerator'
import type { HostEpoch } from '../kernel/domain/values'
import type { Scheduler } from '../kernel/ports/scheduler'
import type { InstallResolver, SuppliersEvent } from '../modules/suppliers'
import { suppliersInstalledTools } from './bridges/installedTools'
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
      integrationGate: { state: () => 'off' },
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

// Added for ISSUE-222: the start-up detection's completion is awaitable (`bootDetection`), so the
// first-run step is evaluated right after it (07 S41.09) and never on a cache a slow first check
// has not filled yet; the rest of the boot does not wait for it.
describe('suppliers wiring boot detection (07 S41.09)', () => {
  const CLAUDE_PATH = '/opt/tools/claude'

  function wired(resolver: InstallResolver, scheduler?: Scheduler) {
    const clock = new FakeClock(1_750_000_000_000)
    const fs = new FakeFs()
    fs.addFile(CLAUDE_PATH, '#!', 7)
    const log = new RecordingDiagnosticsLog()
    const suppliers = wireSuppliers({
      publicBuild: true,
      clock,
      scheduler: scheduler ?? new FakeScheduler(clock),
      ids: new SequenceIdGenerator(),
      fs,
      log,
      installResolver: resolver,
      capabilityRecords: { record: () => undefined, latest: () => null },
      integrationGate: { state: () => 'off' },
      bus: new RecordingEventBus<SuppliersEvent>(),
      hostEpoch: 'epoch-0222' as HostEpoch,
      simulatedSeed: 'seed'
    })
    return { clock, log, suppliers }
  }

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  it('[US-SET-012.AC07, S41.09] a first check slower than the detection budget is waited for: the boot detection completes only once its answer is in the cache', async () => {
    let answerClaude: (() => void) | undefined
    const resolver: InstallResolver = {
      resolve: (binaries) =>
        binaries.includes('claude')
          ? new Promise((resolve) => {
              answerClaude = () => resolve({ path: CLAUDE_PATH, resolvedVia: 'path' })
            })
          : Promise.resolve(null)
    }
    const { clock, suppliers } = wired(resolver)
    let completed: 'detected' | 'failed' | undefined
    void suppliers.bootDetection.then((outcome) => (completed = outcome))
    const installed = suppliersInstalledTools(() => suppliers.catalogue)

    // The 500 ms budget of the first pass, and of any later one, runs out while Claude Code's
    // check is still running (a cold start): the boot detection keeps waiting for it.
    for (let budgets = 0; budgets < 4; budgets++) {
      await settle()
      clock.advance(500)
      await settle()
      expect(installed.installed()).toStrictEqual([])
      expect(completed).toBeUndefined()
    }

    answerClaude?.()
    await settle()
    clock.advance(500)
    await settle()

    expect(completed).toBe('detected')
    expect(installed.installed()).toStrictEqual(['claude-hooks'])
  })

  it('[US-SET-012.AC08, FM-001] a start-up detection that fails resolves the boot detection as failed, logged, and never rejects', async () => {
    const broken: Scheduler = {
      after: () => {
        throw new Error('scheduler unavailable')
      }
    }
    const { log, suppliers } = wired({ resolve: () => Promise.resolve(null) }, broken)

    expect(await suppliers.bootDetection).toBe('failed')
    expect(log.entries).toContainEqual(
      expect.objectContaining({ level: 'error', event: 'uncaught', subsystem: 'suppliers' })
    )
  })
})
