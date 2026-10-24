// layer: L2
// L2 (17 §1.2): the permission mode of a supplier launch (ADR-011 item 1; 14 §3.4 `LaunchParams.permissionMode`;
// 15 §1.2 `DriverLaunchRequest.permissionMode`) over the launching store doubles, the FakeSessionStarter and one
// installed supplier stub. A mode is accepted only while the supplier's entry offers it, and its
// `PermissionModeSpec` is what the driver gets. FakeClock, FakeScheduler: no real time, no process, no disk.
import { describe, expect, it } from 'vitest'
import type { FolderPath, HostEpoch, MineId, ProviderId } from '../../../kernel/domain/values'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { MineView } from '../../mines'
import type { PermissionModeSpec, ProviderDriver, SupplierEntry } from '../../suppliers'
import {
  createLaunching,
  LaunchRefusedError,
  type LaunchingEvent,
  type LaunchRequestInput
} from '..'
import { FakeSessionStarter } from '../testing/FakeSessionStarter'
import { inMemoryLaunching } from '../testing/inMemoryLaunching'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-228' as HostEpoch
const MINE = '00000000-0000-7000-8000-0000000228a1' as MineId
const FOLDER = '/work/deep-seam' as FolderPath
const SUPPLIER = 'synthetic' as ProviderId

const ASK_FIRST: PermissionModeSpec = {
  id: 'ask-first',
  label: 'Ask first',
  needs: 'interactive',
  providerArgs: {}
}

/** One installed supplier: launching only detects through it; the FakeSessionStarter starts it. */
const DRIVER = {
  transport: 'acp',
  detect: async () => ({
    kind: 'installed',
    install: {
      providerId: SUPPLIER,
      binaryPath: '/bin/synthetic',
      version: '1.0.0',
      resolvedVia: 'path',
      statMtimeMs: 0
    }
  })
} as unknown as ProviderDriver

function entry(permissionModes: string[]): SupplierEntry {
  return {
    providerId: SUPPLIER,
    label: 'Synthetic',
    models: [],
    efforts: [],
    permissionModes,
    installed: true,
    publicLaunch: 'enabled',
    answerChannel: 'available'
  }
}

/**
 * A Host whose supplier entry offers `offered` and whose catalogue answers `specs` for `offeredMode`
 * (wiring binds suppliers' own; here the two can disagree, to prove launching fails closed).
 */
function host(offered: string[], specs: readonly PermissionModeSpec[]) {
  const db = inMemoryLaunching(T0)
  const clock = db.clock
  const scheduler = new FakeScheduler(clock)
  const bus = new RecordingEventBus<LaunchingEvent>()
  const starter = new FakeSessionStarter({ clock, scheduler, supplierLabel: 'Synthetic' })
  const mine = { id: MINE, state: 'active' } as MineView
  const launching = createLaunching({
    launches: db.launches,
    processes: db.processes,
    records: db.records,
    transactions: { inTransaction: (work) => db.inTransaction(work) },
    starter,
    suppliers: {
      registry: { drivers: (id) => (id === SUPPLIER ? [DRIVER] : []) },
      launchDriver: async (id) => (id === SUPPLIER ? DRIVER : undefined),
      catalogue: { entry: (id) => (id === SUPPLIER ? entry(offered) : null) },
      offeredMode: (id, modeId) =>
        id === SUPPLIER ? (specs.find((spec) => spec.id === modeId) ?? null) : null,
      bindings: { bind: () => undefined }
    },
    mines: {
      get: (id) => (id === MINE ? mine : null),
      folderOf: (id) => (id === MINE ? FOLDER : null)
    },
    crew: {
      arrive: () => '00000000-0000-7000-8000-0000000228d1' as never,
      sessionClosed: () => undefined
    },
    bus,
    clock,
    scheduler,
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH,
    installId: '00000000-0000-7000-8000-0000000228ff',
    log: new RecordingDiagnosticsLog()
  })
  return {
    db,
    bus,
    starter,
    launching,
    async run(ms: number): Promise<void> {
      for (let left = ms; left > 0; left -= 10) {
        clock.advance(Math.min(10, left))
        for (let i = 0; i < 20; i += 1) await Promise.resolve()
      }
    }
  }
}

const REQUEST: LaunchRequestInput = {
  mineId: MINE,
  way: { kind: 'supplier', providerId: SUPPLIER },
  prompt: 'Shore up the east gallery',
  jevOn: false,
  jevAutoAccept: false
}

/** Past the FakeSessionStarter's early window. */
const SETTLE_MS = 3_200

describe('LaunchUseCase: the permission mode of a supplier launch (ADR-011 item 1)', () => {
  it('[US-LAUNCH-001.AC13, ADR-011, INV-42] a launch with a mode the entry offers is accepted and the driver gets that mode spec', async () => {
    const h = host(['ask-first'], [ASK_FIRST])

    await expect(
      h.launching.commands.launch({ ...REQUEST, permissionMode: 'ask-first' })
    ).resolves.toMatchObject({ launchId: expect.any(String) })
    await h.run(SETTLE_MS)

    expect(h.starter.starts.map((start) => start.req.permissionMode)).toEqual([ASK_FIRST])
    const [launched] = h.bus.ofType('DwarfLaunched')
    expect(h.db.launches.byId(launched?.payload.launchId as never)).toMatchObject({
      state: 'succeeded',
      request: { permissionMode: 'ask-first' }
    })
    expect(h.db.records.live()).toMatchObject([
      { launchOptions: { providerId: SUPPLIER, permissionMode: 'ask-first' } }
    ])
  })

  it('[US-LAUNCH-001.AC14, ADR-011] a launch that names no mode starts the driver with no mode', async () => {
    const h = host(['ask-first'], [ASK_FIRST])

    await h.launching.commands.launch(REQUEST)
    await h.run(SETTLE_MS)

    expect(h.starter.starts.map((start) => start.req.permissionMode)).toEqual([null])
  })

  it('[US-LAUNCH-001.AC11, ADR-011, INV-42] a mode the entry does not offer now, or whose spec the catalogue does not answer, is refused mode-not-offered before any row', async () => {
    const refusals: {
      offered: string[]
      specs: PermissionModeSpec[]
      input: LaunchRequestInput
    }[] = [
      // Never offered: an unknown mode.
      {
        offered: ['ask-first'],
        specs: [ASK_FIRST],
        input: { ...REQUEST, permissionMode: 'full-access' }
      },
      // Not offered now: the entry lists none (no answer channel).
      { offered: [], specs: [ASK_FIRST], input: { ...REQUEST, permissionMode: 'ask-first' } },
      // Listed, but no spec answered: it cannot reach the driver, so it is not offered (fail closed).
      { offered: ['ask-first'], specs: [], input: { ...REQUEST, permissionMode: 'ask-first' } }
    ]
    for (const { offered, specs, input } of refusals) {
      const h = host(offered, specs)
      const refused = h.launching.commands.launch(input)
      await expect(refused).rejects.toBeInstanceOf(LaunchRefusedError)
      await expect(refused).rejects.toMatchObject({ reason: 'mode-not-offered' })
      await h.run(SETTLE_MS)
      expect(h.db.launches.snapshot().size).toBe(0)
      expect(h.bus.published).toEqual([])
      expect(h.starter.starts).toEqual([])
    }
  })
})
