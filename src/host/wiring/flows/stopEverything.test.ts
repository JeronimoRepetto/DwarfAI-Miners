// layer: L2
// L2 flow F13 (17 §1.2; 11 F13; UC-023; ADR-002 D7 step 3; ADR-014 item 9; ADR-015 item 8; 07
// S12.11, S12.12, S12.21, S15.02, S4.05–S4.07; 13 FM-143, FM-144; 06 INV-120, INV-121, INV-122):
// Stop everything and quit through the Host, composed as the Host composes it — B-M05
// `host.shutdown {stop-all}` on the transport Dispatcher with the clean exit, bound to launching's
// `stopAll`, which waits for the launches in flight and ends every owned session through crew's
// `endOwned`; the launching module over its in-memory stores, launched through the
// `SessionStarter` bridge over the suppliers module's SimulatedDriver (15 §4.12), whose event sink
// is the `DriverSessionExited` route (routes/launching.ts `routeSessionExits`); the stop routes
// (`routeStops`), the launching routes (`StopAllIncomplete` → one `toast`) and crew's board frames
// on one connection registry that checks every frame against its 14 §3.5 schema. FakeClock,
// FakeScheduler, RecordingEventBus: no real time, no process, no disk.
//
// The SessionTerminator is a double (16 §2.8), as in stopDwarf.test.ts: `OwnedEnd` ends an owned
// session the way ADR-014 items 1 and 3 say the owned path does — the driver's graceful close over
// the suppliers channel — and answers `ended` once the session's `exited` was delivered, or answers
// a scripted outcome, or never answers. It refuses a dwarf with no launch record: an observed
// session is never signalled (INV-120). The bridge's own paths are bridges/sessionTerminator.test.ts's.
//
// The L9 case of this behaviour moved with its file to the 3a switch (later: ISSUE-001).
//
// TC-175-01, TC-175-02, TC-175-03.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  CATALOG_PROVIDER_IDS,
  HOST_FRAME_SCHEMAS,
  type HostFrameData,
  type HostFrameName
} from '@dwarfai/contracts'
import type {
  DwarfId,
  FolderPath,
  HostEpoch,
  LaunchId,
  MineId,
  ProviderId,
  ProviderIdentity
} from '../../kernel/domain/values'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { RecordingShutdownCheckpoint } from '../../kernel/fakes/RecordingShutdownCheckpoint'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { inMemoryConversation } from '../../modules/conversation/testing/inMemoryConversation'
import {
  CrewEndOwned,
  PendingEndMemory,
  type CrewEndEvent,
  type EndOutcome,
  type EndReason,
  type SessionTerminator
} from '../../modules/crew'
import { inMemoryCrew } from '../../modules/crew/testing/inMemoryCrew'
import { createLaunching, type LaunchingEvent, type LaunchRecord } from '../../modules/launching'
import { inMemoryLaunching } from '../../modules/launching/testing/inMemoryLaunching'
import type { MineView } from '../../modules/mines'
import {
  createSuppliers,
  type DriverSession,
  type SuppliedEventDelivery,
  type SuppliedEventSink
} from '../../modules/suppliers'
import { SimulatedDriver } from '../../modules/suppliers/adapters/drivers/simulated/SimulatedDriver'
import { ConnectionRegistry, type AttachedConnection } from '../../transport/connectionRegistry'
import { Dispatcher, type ResponseFrame } from '../../transport/dispatcher'
import { publishBoardFrames } from '../../transport/frames/board'
import { createCleanExit } from '../../transport/lifecycle/cleanExit'
import { createUpgradeDrain } from '../../transport/lifecycle/drain'
import { HostStateHolder } from '../../transport/lifecycle/hostState'
import { NO_LEDGER_TOTALS } from '../../transport/mappers/wire'
import { registerHostShutdown } from '../../transport/methods/hostShutdown'
import { createSessionStarter } from '../bridges/sessionStarter'
import { emptyDrainGate } from '../emptyDrainGate'
import { routeLaunching, routeSessionExits, routeStops } from '../routes/launching'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-175' as HostEpoch
const MINE = '00000000-0000-7000-8000-0000000175a1' as MineId
const FOLDER = '/work/deep-seam' as FolderPath
const SIMULATED = 'simulated' as ProviderId
const PROMPT = 'Follow the deep seam'
const SEED = 'seed-175'
const REQUEST = '01890a5d-ac96-774b-bcce-000000001752'

const MINE_VIEW: MineView = {
  id: MINE,
  path: FOLDER as unknown as MineView['path'],
  name: 'deep-seam' as MineView['name'],
  state: 'active',
  tier: null,
  sourceWeight: null,
  hasBeenMeasured: false,
  createdAt: T0,
  lastUsedAt: T0,
  presentDwarfs: 0
}

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, { parse(value: unknown): unknown } | undefined>> =
    HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

interface Sent {
  name: HostFrameName
  data: unknown
}

type HostBusEvent = LaunchingEvent | CrewEndEvent

/** Every session the SimulatedDriver hands out (call-through). */
let handedOut: MockInstance<SimulatedDriver['launch']>
beforeEach(() => {
  handedOut = vi.spyOn(SimulatedDriver.prototype, 'launch')
})
afterEach(() => {
  handedOut.mockRestore()
})

/** What the terminator double reads of the Host it ends sessions in. */
interface EndWorld {
  records(): readonly LaunchRecord[]
  channelFor(ref: LaunchRecord['ref']): DriverSession | null
  drain(): Promise<void>
}

/**
 * The owned path of ADR-014 items 1 and 3 as a double: the driver's graceful close over the
 * suppliers channel; `ended` once the session's `exited` was delivered. A scripted outcome is
 * answered with nothing ended; `'hang'` never answers (a process that does not close).
 */
class OwnedEnd implements SessionTerminator {
  readonly calls: Array<{ dwarfId: DwarfId; why: EndReason }> = []
  private readonly scripted = new Map<DwarfId, EndOutcome | 'hang' | 'held'>()
  private readonly held = new Map<DwarfId, () => void>()

  constructor(private readonly world: () => EndWorld) {}

  script(dwarfId: DwarfId, outcome: EndOutcome | 'hang' | 'held'): void {
    this.scripted.set(dwarfId, outcome)
  }

  /** Lets a `'held'` end go on the owned path: a slow kill that ends after all. */
  release(dwarfId: DwarfId): void {
    this.scripted.delete(dwarfId)
    this.held.get(dwarfId)?.()
  }

  async end(dwarfId: DwarfId, why: EndReason): Promise<EndOutcome> {
    const h = this.world()
    this.calls.push({ dwarfId, why })
    const record = h.records().find((r) => r.dwarfId === dwarfId)
    if (record === undefined) throw new Error('OwnedEnd ends owned sessions only (INV-120)')
    const scripted = this.scripted.get(dwarfId)
    if (scripted === 'hang') return new Promise<EndOutcome>(() => undefined)
    if (scripted === 'held') {
      await new Promise<void>((resolve) => this.held.set(dwarfId, resolve))
    } else if (scripted !== undefined) return { ...scripted }
    const channel = h.channelFor(record.ref)
    if (channel === null) return { kind: 'ended' }
    await channel.close('end-thread')
    await h.drain()
    return { kind: 'ended' }
  }

  endAll(): Promise<Map<DwarfId, EndOutcome>> {
    throw new Error('stop-all ends dwarf by dwarf, never through endAll')
  }
}

/** One Host: launching and crew over the SimulatedDriver, the routes, B-M05 and the clean exit. */
function host() {
  const db = inMemoryLaunching(T0)
  const clock = db.clock
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const bus = new RecordingEventBus<HostBusEvent>()
  const crew = inMemoryCrew()
  const conversation = inMemoryConversation()
  const delivered: SuppliedEventDelivery[] = []
  let exits: SuppliedEventSink = { deliver: () => undefined }
  const suppliers = createSuppliers({
    catalogIds: CATALOG_PROVIDER_IDS as unknown as ProviderId[],
    publicBuild: false,
    clock,
    scheduler,
    simulatedSeed: SEED,
    sink: {
      deliver: (delivery) => {
        delivered.push(delivery)
        exits.deliver(delivery)
      }
    },
    installResolver: { resolve: async () => null },
    fs: new FakeFs(),
    capabilityRecords: { record: () => undefined, latest: () => null },
    integrationGate: { state: () => 'off' },
    bus: { publish: () => undefined },
    ids,
    hostEpoch: EPOCH
  })

  const launching = createLaunching({
    launches: db.launches,
    processes: db.processes,
    records: db.records,
    transactions: { inTransaction: (work) => db.inTransaction(work) },
    starter: createSessionStarter({
      registry: suppliers.registry,
      sessions: suppliers.sessions,
      clock,
      scheduler
    }),
    suppliers: {
      registry: suppliers.registry,
      catalogue: suppliers.catalogue,
      bindings: suppliers.bindings
    },
    mines: {
      get: (id) => (id === MINE ? MINE_VIEW : null),
      folderOf: (id) => (id === MINE ? FOLDER : null)
    },
    crew: crew.commands,
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH,
    installId: '00000000-0000-7000-8000-0000000175ff',
    log
  })

  // As createCrew decorates its repository: the pending `why` is Host memory beside the rows.
  const pendingEnds = new PendingEndMemory(crew.repository)
  const queries = {
    get: (dwarfId: DwarfId) => {
      const view = crew.queries.get(dwarfId)
      return view === null ? null : { ...view, pendingEnd: pendingEnds.pendingEndOf(dwarfId) }
    }
  }
  exits = routeSessionExits({ launching, crew: { queries, commands: crew.commands } })

  const drain = async (): Promise<void> => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve()
  }
  const terminator = new OwnedEnd(() => ({
    records: () => db.records.all(),
    channelFor: (ref) => suppliers.sessions.sessionFor(ref),
    drain
  }))
  const ends = new CrewEndOwned({
    repository: pendingEnds,
    transactions: crew.transactionRunner,
    bus,
    clock,
    ids,
    hostEpoch: EPOCH,
    terminator,
    departures: crew.commands
  })

  const connections = new ConnectionRegistry({ validateFrame })
  routeLaunching({
    events: bus,
    launching,
    conversation: conversation.commands,
    frames: connections
  })
  routeStops({ events: bus, launching, frames: connections })

  publishBoardFrames({
    events: {
      mines: new RecordingEventBus(),
      crew: crew.bus,
      observation: new RecordingEventBus()
    },
    mines: { get: () => null },
    crew: crew.queries,
    ledger: NO_LEDGER_TOTALS,
    frames: connections
  })

  // B-M05 on the transport, bound to launching's `stopAll` as host/main.ts binds the StopAllPort.
  const journal: string[] = []
  const exitCodes: number[] = []
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'n/a' })
  const dispatcher = new Dispatcher({ log, clock, scheduler, state: () => state.current().state })
  const lifecycle = createCleanExit({
    checkpoint: new RecordingShutdownCheckpoint(journal),
    connections,
    endpoint: { close: () => Promise.resolve() },
    scheduler,
    log,
    exit: (code) => exitCodes.push(code)
  })
  registerHostShutdown(dispatcher, {
    stopAll: launching.stopAll({ crew: ends }),
    lifecycle,
    log,
    drain: createUpgradeDrain({ gate: emptyDrainGate, state, scheduler, lifecycle, log })
  })

  const ui: Sent[] = []
  const window: AttachedConnection = {
    role: 'ui',
    clientId: 'c-ui-175',
    send<F extends HostFrameName>(name: F, data: HostFrameData[F]): void {
      ui.push({ name, data })
    },
    end: async () => undefined
  }
  connections.attach(window)

  return {
    db,
    bus,
    crew,
    launching,
    terminator,
    connections,
    window,
    ui,
    journal,
    exitCodes,
    state,
    /** Moves the clock by `ms` in 10 ms steps, letting promise jobs run in between. */
    async run(ms: number): Promise<void> {
      let left = ms
      do {
        const step = Math.min(10, left)
        clock.advance(step)
        left -= step
        for (let i = 0; i < 20; i += 1) await Promise.resolve()
      } while (left > 0)
    },
    drain,
    /** The tray's confirmed Stop everything and quit: `host.shutdown {stop-all}` from a `ui` connection. */
    async stopEverything(): Promise<ResponseFrame> {
      const res = await dispatcher.dispatch(
        { id: 'r-175', method: 'host.shutdown', params: { mode: 'stop-all', requestId: REQUEST } },
        { role: 'ui', clientId: window.clientId }
      )
      await drain()
      return res
    }
  }
}

type Host = ReturnType<typeof host>

/** How long a launch over the SimulatedDriver takes to settle: the early window and a margin. */
const SETTLE_MS = 3_200

async function launch(h: Host): Promise<LaunchId> {
  const { launchId } = await h.launching.commands.launch({
    mineId: MINE,
    way: { kind: 'supplier', providerId: SIMULATED },
    prompt: PROMPT,
    jevOn: false,
    jevAutoAccept: false
  })
  return launchId
}

/** Launches one dwarf through the Host and returns its id. */
async function launchedDwarf(h: Host): Promise<DwarfId> {
  const launchId = await launch(h)
  await h.run(SETTLE_MS)
  const launched = h.bus.ofType('DwarfLaunched').find((e) => e.payload.launchId === launchId)
  if (launched === undefined) throw new Error('the launch did not land')
  return launched.payload.dwarfId
}

/** A session the person started in their own terminal: a dwarf with no launch record. */
function observedDwarf(h: Host, session: string): DwarfId {
  const identity: ProviderIdentity = { providerId: 'claude', providerSessionId: session }
  return h.crew.commands.arrive({ mineId: MINE, identity, rank: 'foreman', status: 'idle' })
}

function framesNamed(sent: readonly Sent[], name: HostFrameName): Sent[] {
  return sent.filter((frame) => frame.name === name)
}

describe('Stop everything and quit (F13)', () => {
  it('[US-RES-002.AC09, INV-120, INV-121] stop-all ends every owned session, each departs stopped, observed sessions keep running and the Host exits after every end settled', async () => {
    const h = host()
    const first = await launchedDwarf(h)
    const second = await launchedDwarf(h)
    const observed = observedDwarf(h, 'own-terminal-1')

    const res = await h.stopEverything()

    expect(res).toMatchObject({
      ok: true,
      result: { mode: 'stop-all', outcome: { ended: [first, second], failed: [] } }
    })
    expect(h.terminator.calls).toEqual([
      { dwarfId: first, why: 'stop-all' },
      { dwarfId: second, why: 'stop-all' }
    ])
    expect(framesNamed(h.ui, 'dwarf.departed').map((frame) => frame.data)).toEqual([
      { dwarfId: first, mineId: MINE, cause: 'stopped' },
      { dwarfId: second, mineId: MINE, cause: 'stopped' }
    ])
    // Each owned session's record ended, stopped by the person: no PO #62 crash toast.
    expect(h.db.records.live()).toEqual([])
    expect(h.db.records.all()).toMatchObject([
      { dwarfId: first, stoppedByPerson: true, resumeIntent: false },
      { dwarfId: second, stoppedByPerson: true, resumeIntent: false }
    ])
    expect(h.bus.ofType('LaunchedSessionCrashed')).toEqual([])
    expect(framesNamed(h.ui, 'toast')).toEqual([])
    // The session the person started in their own terminal keeps running.
    expect(h.crew.queries.get(observed)).toMatchObject({ departed: false, stopInFlight: false })
    // Every end settled, then the checkpoint, host.closing and the exit (S12.12).
    expect(h.journal).toEqual(['checkpoint.flush', 'checkpoint.markClean:stop-all'])
    expect(framesNamed(h.ui, 'host.closing').map((frame) => frame.data)).toEqual([
      { reason: 'stop-all', clean: true }
    ])
    expect(h.exitCodes).toEqual([0])
  })

  it('[FM-143, S12.21] one owned session that cannot be ended keeps the Host running and yields one StopAllIncomplete naming it, with no per-dwarf toast', async () => {
    const h = host()
    const ended = await launchedDwarf(h)
    const stuck = await launchedDwarf(h)
    h.terminator.script(stuck, { kind: 'failed', reason: 'still-alive' })

    const res = await h.stopEverything()

    expect(res).toMatchObject({
      ok: true,
      result: { mode: 'stop-all', outcome: { ended: [ended], failed: [stuck] } }
    })
    expect(h.bus.ofType('StopAllIncomplete').map((event) => event.payload)).toEqual([
      { requestId: REQUEST, ended: [ended], failed: [stuck] }
    ])
    // ONE danger message naming the dwarf that could not be ended; no `dwarf-stop-failed` toast.
    expect(framesNamed(h.ui, 'toast').map((frame) => frame.data)).toEqual([
      { kind: 'stop-all-incomplete', requestId: REQUEST, ended: [ended], failed: [stuck] }
    ])
    expect(h.crew.queries.get(stuck)).toMatchObject({ departed: false, stopInFlight: false })
    // S4.07: the session is alive, so its record is no longer stopped and keeps its resume intent.
    expect(h.db.records.live()).toMatchObject([
      { dwarfId: stuck, stoppedByPerson: false, resumeIntent: true }
    ])
    // The Host keeps running: no checkpoint, no host.closing, no exit (ADR-002 D7 step 3).
    expect(h.journal).toEqual([])
    expect(framesNamed(h.ui, 'host.closing')).toEqual([])
    expect(h.exitCodes).toEqual([])
    expect(h.state.current().state).toBe('ready')
  })

  it('[FM-144] a launch in flight settles first and, if it succeeded, is ended with the others', async () => {
    const h = host()
    const settled = await launchedDwarf(h)
    const launchId = await launch(h)

    const answered = h.stopEverything()
    await h.drain()
    // Nothing is ended while the launch is in flight.
    expect(h.terminator.calls).toEqual([])

    await h.run(SETTLE_MS)
    const res = await answered

    const late = h.bus.ofType('DwarfLaunched').find((e) => e.payload.launchId === launchId)
    expect(late).toBeDefined()
    const lateDwarf = late?.payload.dwarfId
    expect(res).toMatchObject({
      ok: true,
      result: { mode: 'stop-all', outcome: { ended: [settled, lateDwarf], failed: [] } }
    })
    expect(h.terminator.calls.map((call) => call.dwarfId)).toEqual([settled, lateDwarf])
    expect(h.exitCodes).toEqual([0])
  })

  it('[US-RES-002.AC09, FM-144] a launch accepted during a slow end is ended too, and the Host never closes cleanly with it alive', async () => {
    const h = host()
    const first = await launchedDwarf(h)
    h.terminator.script(first, 'held')

    const answered = h.stopEverything()
    await h.drain()
    // While the first end runs, a launch is accepted and lands.
    const launchId = await launch(h)
    await h.run(SETTLE_MS)
    const late = h.bus.ofType('DwarfLaunched').find((e) => e.payload.launchId === launchId)
    expect(late).toBeDefined()
    const lateDwarf = late?.payload.dwarfId
    expect(h.exitCodes).toEqual([])
    h.terminator.release(first)
    const res = await answered
    await h.drain()

    expect(res).toMatchObject({
      ok: true,
      result: { mode: 'stop-all', outcome: { ended: [first, lateDwarf], failed: [] } }
    })
    expect(h.terminator.calls.map((call) => call.dwarfId)).toEqual([first, lateDwarf])
    expect(h.db.records.live()).toEqual([])
    expect(h.exitCodes).toEqual([0])
  })

  it('[ADR-015] stop-all clears every resume intent before the ends settle, so a crash during it leaves no record with a resume intent', async () => {
    const h = host()
    const first = await launchedDwarf(h)
    const second = await launchedDwarf(h)
    // Neither end answers: the Host is mid stop-all when it would crash (S12.18).
    h.terminator.script(first, 'hang')
    h.terminator.script(second, 'hang')

    void h.stopEverything()
    await h.drain()

    expect(h.terminator.calls.map((call) => call.dwarfId)).toEqual([first, second])
    expect(h.db.records.live()).toMatchObject([
      { dwarfId: first, stoppedByPerson: true, resumeIntent: false },
      { dwarfId: second, stoppedByPerson: true, resumeIntent: false }
    ])
    expect(h.exitCodes).toEqual([])
  })

  it('[INV-122] a plain quit sends no host.shutdown and ends nothing', async () => {
    const h = host()
    const owned = await launchedDwarf(h)

    // Quit closes the windows: the connection goes, and nothing is sent to the Host.
    h.connections.detach(h.window)
    await h.drain()

    expect(h.terminator.calls).toEqual([])
    expect(h.crew.queries.get(owned)).toMatchObject({ departed: false })
    expect(h.db.records.live()).toMatchObject([{ dwarfId: owned, resumeIntent: true }])
    expect(h.journal).toEqual([])
    expect(h.exitCodes).toEqual([])
  })
})
