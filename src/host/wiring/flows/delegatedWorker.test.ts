// layer: L2
// L2 flow (17 §1.2; UC-017 "WorkerLauncher.launchWorker"; ISSUE-180): a delegated worker launched
// through the `WorkerLauncher` bridge into the launching module over its in-memory stores, the
// FakeSessionStarter (the same contract as the SessionStarter bridge, 16 §2.8), the suppliers
// module's simulated entry and the in-memory crew. FakeClock, FakeScheduler and a
// RecordingEventBus: no real time, no process. Each settled launch is then written through the
// SQLite `LaunchStore` over the run's template database, so the stored row meets the real 09 §4.3
// CHECKs of `launches`.
//
// TC-180-01 (the bridge answers after settlement), TC-180-02 (the stored row and the worker dwarf).
import { describe, expect, it } from 'vitest'
import { CATALOG_PROVIDER_IDS, type JevSuggestionView } from '@dwarfai/contracts'
import type { DwarfId, HostEpoch, LaunchId, ProviderId } from '../../kernel/domain/values'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { rankForDepth } from '../../modules/crew'
import { inMemoryCrew } from '../../modules/crew/testing/inMemoryCrew'
import { createLaunching, type Launch, type LaunchingEvent } from '../../modules/launching'
import { SqliteLaunchStore } from '../../modules/launching/adapters/sqlite/SqliteLaunchStore'
import { FakeSessionStarter } from '../../modules/launching/testing/FakeSessionStarter'
import { inMemoryLaunching } from '../../modules/launching/testing/inMemoryLaunching'
import {
  MINE,
  MINE_FOLDER,
  T0,
  seedDelegation,
  seedDwarf,
  seedMine
} from '../../modules/launching/testing/sqliteLaunchingDb'
import type { MineView } from '../../modules/mines'
import { createSuppliers } from '../../modules/suppliers'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { createWorkerLauncher } from '../bridges/workerLauncher'

const EPOCH = 'epoch-180' as HostEpoch
const SIMULATED = 'simulated' as ProviderId
const DELEGATION = '00000000-0000-7000-8000-0000000180de'
const TASK = 'Map the old shafts below the north seam'
/** Past the FakeSessionStarter's early window. */
const SETTLE_MS = 3_200

const PICK: JevSuggestionView = {
  providerId: SIMULATED,
  model: 'sim-small',
  effort: 'low',
  confidence: { providerId: 0.9 },
  truncated: false,
  parts: { providerId: 'answered', model: 'answered', effort: 'answered' }
}

function host() {
  const db = inMemoryLaunching(T0)
  const clock = db.clock
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const bus = new RecordingEventBus<LaunchingEvent>()
  const crew = inMemoryCrew()
  const suppliers = createSuppliers({
    catalogIds: CATALOG_PROVIDER_IDS as unknown as ProviderId[],
    publicBuild: false,
    clock,
    scheduler,
    simulatedSeed: 'seed-180',
    sink: { deliver: () => undefined },
    installResolver: { resolve: async () => null },
    fs: new FakeFs(),
    capabilityRecords: { record: () => undefined, latest: () => null },
    integrationGate: { state: () => 'off' },
    bus: { publish: () => undefined },
    ids,
    hostEpoch: EPOCH
  })
  const starter = new FakeSessionStarter({
    clock,
    scheduler,
    supplierLabel: 'Simulated',
    capabilities: suppliers.catalogue.capabilities(SIMULATED)
  })
  const mine = { id: MINE, state: 'active' } as MineView
  const launching = createLaunching({
    launches: db.launches,
    processes: db.processes,
    records: db.records,
    transactions: { inTransaction: (work) => db.inTransaction(work) },
    starter,
    suppliers: {
      registry: suppliers.registry,
      launchDriver: suppliers.launchDriver,
      catalogue: { entry: (id) => suppliers.catalogue.entry(id) },
      // The double hands out sessions suppliers never saw: only the bridge's can be bound.
      bindings: { bind: () => undefined }
    },
    mines: {
      get: (id) => (id === MINE ? mine : null),
      folderOf: (id) => (id === MINE ? MINE_FOLDER : null)
    },
    crew: crew.commands,
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH,
    installId: '00000000-0000-7000-8000-0000000180ff',
    log: new RecordingDiagnosticsLog()
  })
  const launcher = createWorkerLauncher({
    launching: launching.commands,
    events: bus,
    crew: crew.queries
  })
  // The delegating dwarf: a root launch, always a foreman (INV-27).
  const parent = crew.commands.arrive({
    mineId: MINE,
    identity: { providerId: 'claude', providerSessionId: 'parent-session' },
    rank: rankForDepth(0),
    status: 'working'
  })
  return {
    db,
    bus,
    crew,
    starter,
    launcher,
    parent,
    /** Moves the clock in 10 ms steps, letting promise jobs run in between. */
    async run(ms: number): Promise<void> {
      for (let left = ms; left > 0; left -= 10) {
        clock.advance(Math.min(10, left))
        for (let i = 0; i < 20; i += 1) await Promise.resolve()
      }
    }
  }
}

/** The launch written through `SqliteLaunchStore`, read back as its raw `launches` row. */
function storedRow(launch: Launch, parent: DwarfId) {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  seedMine(db, runner)
  seedDwarf(db, runner, parent)
  if (launch.dwarfId !== undefined) seedDwarf(db, runner, launch.dwarfId)
  seedDelegation(db, runner, DELEGATION, parent)
  const store = new SqliteLaunchStore({
    db,
    scope: runner,
    clock: { now: () => T0 },
    folderOf: (id) => (id === MINE ? MINE_FOLDER : null)
  })
  runner.inTransaction(() => store.put(launch))
  const [row] = db.all(
    `SELECT state, delegated, delegation_id, launched_with_let_jev_choose, failure_cause, jev_reason
       FROM launches WHERE id = ?`,
    [launch.id]
  )
  return { db, runner, row }
}

describe('delegated worker launch', () => {
  it('[INV-28, INV-27] the worker arrives delegated, as a worker of the delegating dwarf', async () => {
    const h = host()

    const answer = h.launcher.launchWorker(DELEGATION, h.parent, PICK, TASK)
    await h.run(SETTLE_MS)

    const settled = await answer
    if (!settled.ok) throw new Error(`the worker launch failed: ${settled.error}`)
    expect(h.crew.repository.byId(settled.value)).toMatchObject({
      mineId: MINE,
      delegated: true,
      parentDwarfId: h.parent,
      rank: 'worker'
    })
    const arrived = h.crew.bus.ofType('DwarfArrived').map((e) => e.payload)
    expect(arrived.at(-1)).toMatchObject({
      dwarfId: settled.value,
      parentDwarfId: h.parent,
      delegated: true,
      rank: 'worker'
    })
    expect(h.bus.ofType('DwarfLaunched').map((e) => e.payload)).toMatchObject([
      { dwarfId: settled.value, parentDwarfId: h.parent, delegated: true, prompt: TASK }
    ])
  })

  it('[ADR-013] a delegated launch is stored delegated with launched_with_let_jev_choose 0 and gets no delegation entry', async () => {
    const h = host()

    const answer = h.launcher.launchWorker(DELEGATION, h.parent, PICK, TASK)
    await h.run(SETTLE_MS)
    const settled = await answer

    expect(settled.ok).toBe(true)
    // No delegation entry for the worker (depth one, INV-81): the SessionStarter bridge, which
    // calls `DelegationLifecycle.issueFor`, is told the launch is not "Let Jev choose".
    expect(h.starter.starts.map((s) => [s.gate, s.req.delegation])).toEqual([
      [{ launchedWithLetJevChoose: false }, null]
    ])
    const [launched] = h.bus.ofType('DwarfLaunched')
    const launch = h.db.launches.byId(launched?.payload.launchId as LaunchId)
    expect(launch).not.toBeNull()
    const { row } = storedRow(launch as Launch, h.parent)
    expect(row).toEqual({
      state: 'succeeded',
      delegated: 1,
      delegation_id: DELEGATION,
      launched_with_let_jev_choose: 0,
      failure_cause: null,
      jev_reason: null
    })
    expect(h.db.records.live()).toMatchObject([{ launchedWithLetJevChoose: false }])
  })

  it('[S5.15, ADR-028] a delegated effort-ceiling fallback fails jev-could-not-choose and is never handed-back', async () => {
    const h = host()
    const fellBack: JevSuggestionView = {
      confidence: {},
      truncated: false,
      parts: {},
      fallback: 'effort-ceiling'
    }

    const answer = h.launcher.launchWorker(DELEGATION, h.parent, fellBack, TASK)
    await h.run(SETTLE_MS)

    expect(await answer).toEqual({ ok: false, error: 'jev-could-not-choose' })
    expect(h.starter.starts).toEqual([])
    const [failed] = h.bus.ofType('LaunchFailed')
    const launch = h.db.launches.byId(failed?.payload.launchId as LaunchId)
    const { db, runner, row } = storedRow(launch as Launch, h.parent)
    expect(row).toEqual({
      state: 'failed',
      delegated: 1,
      delegation_id: DELEGATION,
      launched_with_let_jev_choose: 0,
      failure_cause: 'jev-could-not-choose',
      jev_reason: 'effort-ceiling'
    })
    // 09 §4.3: a delegated launch can never be handed back.
    expect(() =>
      runner.inTransaction(() =>
        db.run(
          `UPDATE launches SET state = 'handed-back', failure_cause = NULL, jev_reason = NULL
                 WHERE id = ?`,
          [launch?.id ?? '']
        )
      )
    ).toThrow(/CHECK constraint failed/)
  })
})
