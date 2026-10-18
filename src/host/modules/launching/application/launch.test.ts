// layer: L2
// L2 (17 §1.2): `LaunchCommands.launch` for a delegated worker (ISSUE-180; ADR-013 items 1, 4;
// 09 D-17; 07 S5.10, S5.12, S5.14, S5.15, S5.21) over the launching store doubles, the
// FakeSessionStarter, a recording crew and one installed supplier stub. FakeClock,
// FakeScheduler and a RecordingEventBus: no real time, no process, no disk.
import { describe, expect, it } from 'vitest'
import type {
  DwarfId,
  FolderPath,
  HostEpoch,
  MineId,
  ProviderId
} from '../../../kernel/domain/values'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { CrewCommands } from '../../crew'
import type { MineView } from '../../mines'
import type { ProviderDriver, SupplierEntry } from '../../suppliers'
import { createLaunching, type LaunchingEvent, type LaunchRequestInput } from '..'
import { FakeSessionStarter } from '../testing/FakeSessionStarter'
import { inMemoryLaunching } from '../testing/inMemoryLaunching'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-180' as HostEpoch
const MINE = '00000000-0000-7000-8000-0000000180a1' as MineId
const FOLDER = '/work/deep-seam' as FolderPath
const SIMULATED = 'simulated' as ProviderId
const DELEGATION = '00000000-0000-7000-8000-0000000180de'
const TASK = 'Map the old shafts below the north seam'
const PARENT = '00000000-0000-7000-8000-0000000180d0' as DwarfId
const WORKER = '00000000-0000-7000-8000-0000000180d1' as DwarfId

/** One installed supplier: launching only detects through it; the FakeSessionStarter starts it. */
const DRIVER = {
  transport: 'stream-json',
  detect: async () => ({
    kind: 'installed',
    install: {
      providerId: SIMULATED,
      binaryPath: '/bin/simulated',
      version: '1.0.0',
      resolvedVia: 'path',
      statMtimeMs: 0
    }
  })
} as unknown as ProviderDriver

const ENTRY: SupplierEntry = {
  providerId: SIMULATED,
  label: 'Simulated',
  models: ['sim-small'],
  efforts: ['low'],
  permissionModes: [],
  installed: true,
  publicLaunch: 'enabled',
  answerChannel: 'none'
}

/** What the suppliers' bindings saw when the launch bound its session's held events. */
type BindSeen = (ref: unknown, dwarfId: DwarfId) => void

function host(onBind: BindSeen = () => undefined) {
  const db = inMemoryLaunching(T0)
  const clock = db.clock
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const bus = new RecordingEventBus<LaunchingEvent>()
  // Crew along the launching → crew edge: records each arrival and answers the worker's id.
  const arrivals: Parameters<CrewCommands['arrive']>[0][] = []
  const crew: Pick<CrewCommands, 'arrive' | 'sessionClosed'> = {
    arrive: (input) => {
      arrivals.push(input)
      return WORKER
    },
    sessionClosed: () => undefined
  }
  const starter = new FakeSessionStarter({
    clock,
    scheduler,
    supplierLabel: 'Simulated'
  })
  const mine = { id: MINE, state: 'active' } as MineView
  const launching = createLaunching({
    launches: db.launches,
    processes: db.processes,
    records: db.records,
    transactions: { inTransaction: (work) => db.inTransaction(work) },
    starter,
    suppliers: {
      registry: { drivers: (id) => (id === SIMULATED ? [DRIVER] : []) },
      catalogue: { entry: (id) => (id === SIMULATED ? ENTRY : null) },
      bindings: { bind: (ref, dwarfId) => onBind(ref, dwarfId as DwarfId) }
    },
    mines: {
      get: (id) => (id === MINE ? mine : null),
      folderOf: (id) => (id === MINE ? FOLDER : null)
    },
    crew,
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH,
    installId: '00000000-0000-7000-8000-0000000180ff',
    log: new RecordingDiagnosticsLog()
  })
  return {
    db,
    bus,
    arrivals,
    starter,
    launching,
    parent: PARENT,
    /** Moves the clock in 10 ms steps, letting promise jobs run in between. */
    async run(ms: number): Promise<void> {
      for (let left = ms; left > 0; left -= 10) {
        clock.advance(Math.min(10, left))
        for (let i = 0; i < 20; i += 1) await Promise.resolve()
      }
    }
  }
}

/** The request the WorkerLauncher bridge sends for a pick of the simulated supplier. */
function worker(parent: DwarfId, overrides: Partial<LaunchRequestInput> = {}): LaunchRequestInput {
  return {
    mineId: MINE,
    way: { kind: 'supplier', providerId: SIMULATED },
    model: 'sim-small',
    effort: 'low',
    prompt: TASK,
    jevOn: false,
    jevAutoAccept: false,
    delegation: { delegationId: DELEGATION, parentDwarfId: parent },
    ...overrides
  }
}

/** Past the FakeSessionStarter's early window. */
const SETTLE_MS = 3_200

describe('LaunchUseCase: delegated worker', () => {
  it('[S5.10, S5.12, ADR-013] a delegated launch takes the pick as given and starts with no delegation entry', async () => {
    const h = host()

    const { launchId } = await h.launching.commands.launch(worker(h.parent))
    expect(h.db.launches.byId(launchId)).toMatchObject({
      state: 'routing',
      launchedWithLetJevChoose: false,
      request: { delegation: { delegationId: DELEGATION, parentDwarfId: h.parent } }
    })
    await h.run(SETTLE_MS)

    expect(h.starter.starts).toHaveLength(1)
    const [start] = h.starter.starts
    expect(start?.providerId).toBe(SIMULATED)
    expect(start?.gate).toEqual({ launchedWithLetJevChoose: false })
    expect(start?.req).toMatchObject({
      prompt: TASK,
      model: 'sim-small',
      effort: 'low',
      delegation: null
    })
    expect(h.db.launches.byId(launchId)?.state).toBe('succeeded')
    expect(h.db.records.live()).toMatchObject([{ launchId, launchedWithLetJevChoose: false }])
  })

  it('[INV-28, INV-27, S5.21] the worker dwarf arrives delegated as a worker of its parent and DwarfLaunched says so', async () => {
    const h = host()

    const { launchId } = await h.launching.commands.launch(worker(h.parent))
    await h.run(SETTLE_MS)

    const [launched] = h.bus.ofType('DwarfLaunched')
    expect(launched?.payload).toMatchObject({
      launchId,
      parentDwarfId: h.parent,
      delegated: true,
      prompt: TASK
    })
    expect(launched?.payload.dwarfId).toBe(WORKER)
    expect(h.arrivals).toMatchObject([
      { mineId: MINE, parent: h.parent, rank: 'worker', delegated: true, status: 'working' }
    ])
  })

  it('[S5.15, ADR-028] a delegated effort-ceiling pick fails jev-could-not-choose in routing and nothing starts', async () => {
    const h = host()

    const { launchId } = await h.launching.commands.launch(
      worker(h.parent, {
        way: { kind: 'jev' },
        delegation: {
          delegationId: DELEGATION,
          parentDwarfId: h.parent,
          fallback: 'effort-ceiling'
        }
      })
    )
    await h.run(SETTLE_MS)

    expect(h.starter.starts).toEqual([])
    expect(h.db.launches.byId(launchId)).toMatchObject({
      state: 'failed',
      failure: { cause: 'jev-could-not-choose', jevReason: 'effort-ceiling' }
    })
    expect(h.bus.ofType('LaunchFailed').map((e) => e.payload.failure.cause)).toEqual([
      'jev-could-not-choose'
    ])
    expect(h.bus.ofType('DwarfLaunched')).toEqual([])
  })

  it('[S5.14] a delegated pick that fell back because Jev was unreachable fails jev-unreachable', async () => {
    const h = host()

    const { launchId } = await h.launching.commands.launch(
      worker(h.parent, {
        way: { kind: 'jev' },
        delegation: { delegationId: DELEGATION, parentDwarfId: h.parent, fallback: 'timeout' }
      })
    )
    await h.run(SETTLE_MS)

    expect(h.db.launches.byId(launchId)).toMatchObject({
      state: 'failed',
      failure: { cause: 'jev-unreachable', jevReason: 'timeout' }
    })
  })
})

// ADDED for ISSUE-002: binding a launched session delivers the events its driver held until then (sessionChannels),
// an ask among them. The ask broker reads the dwarf as owned only from its launch record, so the record must exist when
// the bind runs, or an early driver ask is read as an observed request and dropped (07 S1.17).
describe('LaunchUseCase: owning before binding', () => {
  it('[S5.21, ADR-010] the launch record of the dwarf is written before its session is bound, so a held ask meets an owned dwarf', async () => {
    const seen: { db?: ReturnType<typeof host>['db'] } = {}
    const ownedAtBind: boolean[] = []
    const h = host((_ref, dwarfId) => {
      ownedAtBind.push(
        seen.db?.records.live().some((record) => record.dwarfId === dwarfId) ?? false
      )
    })
    seen.db = h.db

    const { launchId } = await h.launching.commands.launch(worker(h.parent))
    await h.run(SETTLE_MS)

    expect(h.db.launches.byId(launchId)?.state).toBe('succeeded')
    expect(ownedAtBind).toEqual([true])
  })
})
