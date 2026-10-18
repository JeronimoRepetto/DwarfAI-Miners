// layer: L2
// L2 (17 §1.2): `LaunchCommands.launch` with "Let Jev choose" (11 F3; UC-009; 07 S5.10, S5.12–S5.15;
// ADR-020 item 2; ADR-028 D2; 16 §4.5, §6.4, §6.5) over the launching store doubles, the
// FakeLaunchAdvisor, the FakeSessionStarter, a recording crew and one installed supplier stub.
// FakeClock, FakeScheduler and a RecordingEventBus: no real time, no process, no network.
// Every test sets "Default provider" explicitly: configured (the fallback suggestion carries it) or
// not (it carries none). TC-164-02: effort-ceiling with a default ends handed-back, no launch.failed.
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
import { JEV_ROUTING_BUDGET_MS } from '../domain/jevFallback'
import { FakeLaunchAdvisor } from '../testing/FakeLaunchAdvisor'
import { FakeSessionStarter } from '../testing/FakeSessionStarter'
import { inMemoryLaunching } from '../testing/inMemoryLaunching'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-164' as HostEpoch
const MINE = '00000000-0000-7000-8000-0000000164b1' as MineId
const FOLDER = '/work/east-gallery' as FolderPath
const SIMULATED = 'simulated' as ProviderId
const DWARF = '00000000-0000-7000-8000-0000000164d1' as DwarfId
const PROMPT = 'Shore up the east gallery before the rains'

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
  models: ['sim-small', 'sim-large'],
  efforts: ['low', 'medium', 'high'],
  permissionModes: [],
  installed: true,
  publicLaunch: 'enabled',
  answerChannel: 'none'
}

/** The configured "Default provider" a fallback suggestion carries (OQ-38 B). */
const CONFIGURED_DEFAULT = { providerId: SIMULATED, model: 'sim-small', effort: 'low' }

function host() {
  const db = inMemoryLaunching(T0)
  const clock = db.clock
  const scheduler = new FakeScheduler(clock)
  const bus = new RecordingEventBus<LaunchingEvent>()
  const crew: Pick<CrewCommands, 'arrive' | 'sessionClosed'> = {
    arrive: () => DWARF,
    sessionClosed: () => undefined
  }
  const starter = new FakeSessionStarter({ clock, scheduler, supplierLabel: 'Simulated' })
  const advisor = new FakeLaunchAdvisor()
  const mine = { id: MINE, state: 'active' } as MineView
  const launching = createLaunching({
    launches: db.launches,
    processes: db.processes,
    records: db.records,
    transactions: { inTransaction: (work) => db.inTransaction(work) },
    starter,
    advisor,
    suppliers: {
      registry: { drivers: (id) => (id === SIMULATED ? [DRIVER] : []) },
      catalogue: { entry: (id) => (id === SIMULATED ? ENTRY : null) },
      bindings: { bind: () => undefined }
    },
    mines: {
      get: (id) => (id === MINE ? mine : null),
      folderOf: (id) => (id === MINE ? FOLDER : null)
    },
    crew,
    bus,
    clock,
    scheduler,
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH,
    installId: '00000000-0000-7000-8000-0000000164ff',
    log: new RecordingDiagnosticsLog()
  })
  return {
    db,
    bus,
    starter,
    advisor,
    launching,
    /** Moves the clock in 10 ms steps, letting promise jobs run in between. */
    async run(ms: number): Promise<void> {
      for (let left = ms; left > 0; left -= 10) {
        clock.advance(Math.min(10, left))
        for (let i = 0; i < 20; i += 1) await Promise.resolve()
      }
    }
  }
}

/** "Let Jev choose" with nothing in the pickers. */
const JEV: LaunchRequestInput = {
  mineId: MINE,
  way: { kind: 'jev' },
  prompt: PROMPT,
  jevOn: true,
  jevAutoAccept: true
}

/** "Let Jev choose" with the pickers holding a supplier, model and effort. */
const JEV_WITH_PICKERS: LaunchRequestInput = {
  ...JEV,
  way: { kind: 'supplier', providerId: SIMULATED },
  model: 'sim-large',
  effort: 'high'
}

/** Long enough for a routed launch to settle, spawn and pass the 3-second early window. */
const SETTLE_MS = 3_500

describe('launch with Jev (F3)', () => {
  it('[US-LAUNCH-006.AC15, S5.15] a saved Jev key that TypeSafe rejects fails the launch jev-could-not-choose with Pick manually and no Retry, discovered only at launch', async () => {
    const h = host()
    h.advisor.arrange({ kind: 'fallback', reason: 'unauthorized' })
    expect(h.advisor.calls).toEqual([])
    const { launchId } = await h.launching.commands.launch(JEV)
    await h.run(SETTLE_MS)
    expect(h.advisor.calls).toHaveLength(1)
    expect(h.advisor.calls[0]).toMatchObject({ prompt: PROMPT, mineId: MINE })
    const [failed] = h.bus.ofType('LaunchFailed')
    expect(failed?.payload).toMatchObject({ launchId, mineId: MINE })
    expect(failed?.payload.failure).toMatchObject({
      cause: 'jev-could-not-choose',
      jevReason: 'unauthorized',
      actions: ['pick-manually']
    })
    expect(h.db.launches.byId(launchId)?.state).toBe('failed')
    expect(h.starter.starts).toEqual([])
  })

  it('[S5.12] a Jev pick continues to resolving with the capped effort, never above the computed one', async () => {
    const h = host()
    // The pickers hold `high`; Jev's capped pick is `medium` (ADR-028 D1).
    h.advisor.arrange({ kind: 'pick', providerId: SIMULATED, model: 'sim-small', effort: 'medium' })
    const { launchId } = await h.launching.commands.launch(JEV_WITH_PICKERS)
    await h.run(SETTLE_MS)
    expect(h.starter.starts).toHaveLength(1)
    const [start] = h.starter.starts
    expect(start?.providerId).toBe(SIMULATED)
    expect(start?.req).toMatchObject({ model: 'sim-small', effort: 'medium' })
    expect(start?.gate).toEqual({ launchedWithLetJevChoose: true })
    expect(h.db.launches.byId(launchId)?.state).toBe('succeeded')
    expect(h.bus.ofType('DwarfLaunched')).toHaveLength(1)
    expect(h.bus.ofType('LaunchFailed')).toEqual([])
  })

  it('[S5.13, ADR-028] an effort-ceiling fallback with a configured default ends handed-back with the default in the picks and no LaunchFailed', async () => {
    const h = host()
    h.advisor.arrange({ kind: 'fallback', reason: 'effort-ceiling', default: CONFIGURED_DEFAULT })
    const { launchId } = await h.launching.commands.launch(JEV)
    await h.run(SETTLE_MS)
    expect(h.bus.ofType('LaunchHandedBack').map((e) => e.payload)).toEqual([
      { launchId, mineId: MINE, picks: CONFIGURED_DEFAULT }
    ])
    expect(h.bus.ofType('LaunchFailed')).toEqual([])
    const launch = h.db.launches.byId(launchId)
    expect(launch?.state).toBe('handed-back')
    expect(launch?.failure).toBeUndefined()
    expect(h.starter.starts).toEqual([])
  })

  it('[S5.15, ADR-028] an effort-ceiling fallback with no configured default fails jev-could-not-choose', async () => {
    const h = host()
    h.advisor.arrange({ kind: 'fallback', reason: 'effort-ceiling' })
    const { launchId } = await h.launching.commands.launch(JEV)
    await h.run(SETTLE_MS)
    expect(h.bus.ofType('LaunchHandedBack')).toEqual([])
    const [failed] = h.bus.ofType('LaunchFailed')
    expect(failed?.payload.failure).toMatchObject({
      cause: 'jev-could-not-choose',
      jevReason: 'effort-ceiling',
      actions: ['pick-manually']
    })
    expect(h.db.launches.byId(launchId)?.failure?.cause).toBe('jev-could-not-choose')
  })

  it('[ADR-020] a Jev cause is set only when nothing went out', async () => {
    // Nothing in the pickers: the fallback launches nothing, so the launch takes its Jev cause.
    const bare = host()
    bare.advisor.arrange({ kind: 'fallback', reason: 'timeout' })
    await bare.launching.commands.launch(JEV)
    await bare.run(SETTLE_MS)
    expect(bare.bus.ofType('LaunchFailed').map((e) => e.payload.failure)).toMatchObject([
      { cause: 'jev-unreachable', jevReason: 'timeout', actions: ['retry', 'pick-manually'] }
    ])
    expect(bare.starter.starts).toEqual([])
    expect(bare.db.processes.live()).toEqual([])
    // The pickers hold a supplier: the fallback launches on their values, so no Jev cause is set.
    const picked = host()
    picked.advisor.arrange({ kind: 'fallback', reason: 'timeout' })
    const { launchId } = await picked.launching.commands.launch(JEV_WITH_PICKERS)
    await picked.run(SETTLE_MS)
    expect(picked.bus.ofType('LaunchFailed')).toEqual([])
    expect(picked.starter.starts.map((s) => s.req)).toMatchObject([
      { model: 'sim-large', effort: 'high' }
    ])
    expect(picked.db.launches.byId(launchId)?.state).toBe('succeeded')
  })

  // TC-164-03: the bridge reports JevAdvisor's `not-configured` as the `no-key` fallback.
  it('[US-LAUNCH-006.AC16, S5.15] with no Jev key stored the launch fails jev-could-not-choose with jevReason no-key and Pick manually only', async () => {
    const h = host()
    h.advisor.arrange({ kind: 'fallback', reason: 'no-key' })
    await h.launching.commands.launch(JEV)
    await h.run(SETTLE_MS)
    expect(h.bus.ofType('LaunchFailed').map((e) => e.payload.failure)).toMatchObject([
      { cause: 'jev-could-not-choose', jevReason: 'no-key', actions: ['pick-manually'] }
    ])
  })

  it('[US-LAUNCH-006.AC17, S5.15] with no launchable provider the launch fails jev-could-not-choose with no action and its fixed sentence', async () => {
    const h = host()
    h.advisor.arrange({ kind: 'fallback', reason: 'no-launchable-provider' })
    await h.launching.commands.launch(JEV)
    await h.run(SETTLE_MS)
    expect(h.bus.ofType('LaunchFailed').map((e) => e.payload.failure)).toMatchObject([
      {
        cause: 'jev-could-not-choose',
        reasonSentence: 'No launchable provider to choose from.',
        actions: []
      }
    ])
  })

  it('[US-LAUNCH-006.AC04, INV-54] Retry after jev-unreachable is a new launch that asks Jev again', async () => {
    const h = host()
    h.advisor.arrange({ kind: 'error', error: 'jev-unreachable' })
    const first = await h.launching.commands.launch(JEV)
    await h.run(SETTLE_MS)
    expect(h.bus.ofType('LaunchFailed').map((e) => e.payload.failure)).toMatchObject([
      { cause: 'jev-unreachable', actions: ['retry', 'pick-manually'] }
    ])
    h.advisor.arrange({ kind: 'pick', providerId: SIMULATED, model: 'sim-small', effort: 'low' })
    const second = await h.launching.commands.launch({ ...JEV, retryOf: first.launchId })
    await h.run(SETTLE_MS)
    expect(h.advisor.calls).toHaveLength(2)
    expect(h.db.launches.byId(second.launchId)).toMatchObject({
      state: 'succeeded',
      retryOf: first.launchId
    })
  })

  it('[S5.14] a Jev that never answers is aborted at the routing budget and fails jev-unreachable with timeout', async () => {
    const h = host()
    h.advisor.arrange({ kind: 'hang' })
    const { launchId } = await h.launching.commands.launch(JEV)
    await h.run(JEV_ROUTING_BUDGET_MS - 10)
    expect(h.db.launches.byId(launchId)?.state).toBe('routing')
    expect(h.advisor.calls[0]?.signal?.aborted).toBe(false)
    await h.run(20)
    expect(h.advisor.calls[0]?.signal?.aborted).toBe(true)
    expect(h.bus.ofType('LaunchFailed').map((e) => e.payload.failure)).toMatchObject([
      { cause: 'jev-unreachable', jevReason: 'timeout' }
    ])
  })
})
