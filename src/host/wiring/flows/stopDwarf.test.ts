// layer: L2
// L2 flow F9 (17 §1.2; 11 F9; UC-019; 07 machine 15 S15.01, S15.13, S15.15, S15.18, 4A S4.05–S4.07;
// 13 FM-060, FM-061, FM-062, FM-140): "Stop dwarf…" through the Host, composed as the Host composes
// it — crew's `stop` over the crew's in-memory doubles, with the pending `why` kept in Host memory
// beside the stored rows (application/stop.ts `PendingEndMemory`, as createCrew decorates its
// repository); the launching module over its in-memory stores, launched through the
// `SessionStarter` bridge over the suppliers module's SimulatedDriver (15 §4.12), whose event sink
// is the `DriverSessionExited` route (routes/launching.ts `routeSessionExits`); the stop routes
// (`routeStops`: `markStoppedByPerson` as the required handler, the stop-failure toast), the
// launching routes and crew's board frames on one connection registry that checks every frame
// against its 14 §3.5 schema. FakeClock, FakeScheduler, RecordingEventBus: no real time, no
// process, no disk.
//
// The SessionTerminator is a double (16 §2.8): `OwnedEnd` ends an owned session the way ADR-014
// items 1 and 3 say the owned path does — the driver's interrupt and graceful close over the
// suppliers channel — and answers `ended` once the session's `exited` was delivered, or answers a
// scripted outcome, or never answers. It records what it saw when it was called, so the order of
// S15.01 (`stopped_by_person` committed first) is observable. The bridge's own owned path and the
// identity-checked tree kill of a real process tree are not this file's: the bridge's observed path
// is ISSUE-079's (bridges/sessionTerminator.test.ts) and the per-OS tree is L8.
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
  MessageId,
  MineId,
  ProviderId
} from '../../kernel/domain/values'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { inMemoryConversation } from '../../modules/conversation/testing/inMemoryConversation'
import {
  CrewStop,
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
import {
  SimulatedDriver,
  type SimulatedSession
} from '../../modules/suppliers/adapters/drivers/simulated/SimulatedDriver'
import { ConnectionRegistry, type AttachedConnection } from '../../transport/connectionRegistry'
import { publishBoardFrames } from '../../transport/frames/board'
import { NO_LEDGER_TOTALS } from '../../transport/mappers/wire'
import { createSessionStarter } from '../bridges/sessionStarter'
import { routeLaunching, routeSessionExits, routeStops } from '../routes/launching'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-171' as HostEpoch
const MINE = '00000000-0000-7000-8000-0000000171a1' as MineId
const FOLDER = '/work/north-face' as FolderPath
const SIMULATED = 'simulated' as ProviderId
const PROMPT = 'Prop the north face'
const SEED = 'seed-171'
const REQUEST = '01890a5d-ac96-774b-bcce-000000001711'

const MINE_VIEW: MineView = {
  id: MINE,
  path: FOLDER as unknown as MineView['path'],
  name: 'north-face' as MineView['name'],
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
  seq: number
}

type HostBusEvent = LaunchingEvent | CrewEndEvent

/** Every session the SimulatedDriver hands out, observed as it leaves the driver (call-through). */
let handedOut: MockInstance<SimulatedDriver['launch']>
beforeEach(() => {
  handedOut = vi.spyOn(SimulatedDriver.prototype, 'launch')
})
afterEach(() => {
  handedOut.mockRestore()
})

/** What the terminator saw when it was asked to end a session. */
interface EndCall {
  dwarfId: DwarfId
  why: EndReason
  /** The dwarf's `launch_records.stopped_by_person` at that moment (null: no record). */
  stoppedByPerson: boolean | null
  stopInFlight: boolean | undefined
}

/** What the terminator double reads of the Host it ends sessions in. */
interface EndWorld {
  records(): readonly LaunchRecord[]
  stopInFlight(dwarfId: DwarfId): boolean | undefined
  channelFor(ref: LaunchRecord['ref']): DriverSession | null
  drain(): Promise<void>
}

/**
 * The owned path of ADR-014 items 1 and 3 as a double: the driver's interrupt, then its graceful
 * close, over the suppliers channel; `ended` once the session's `exited` was delivered. A scripted
 * outcome is answered with nothing ended; `'hang'` never answers (a process that does not close).
 */
class OwnedEnd implements SessionTerminator {
  readonly calls: EndCall[] = []
  private readonly scripted = new Map<DwarfId, EndOutcome | 'hang' | 'reject'>()

  constructor(private readonly world: () => EndWorld) {}

  script(dwarfId: DwarfId, outcome: EndOutcome | 'hang' | 'reject'): void {
    this.scripted.set(dwarfId, outcome)
  }

  async end(dwarfId: DwarfId, why: EndReason): Promise<EndOutcome> {
    const h = this.world()
    const record = h.records().find((r) => r.dwarfId === dwarfId)
    this.calls.push({
      dwarfId,
      why,
      stoppedByPerson: record?.stoppedByPerson ?? null,
      stopInFlight: h.stopInFlight(dwarfId)
    })
    const scripted = this.scripted.get(dwarfId)
    if (scripted === 'hang') return new Promise<EndOutcome>(() => undefined)
    if (scripted === 'reject') throw new Error('the end could not be attempted')
    if (scripted !== undefined) return { ...scripted }
    if (record === undefined) throw new Error('OwnedEnd ends owned sessions only')
    const channel = h.channelFor(record.ref)
    if (channel === null) return { kind: 'ended' }
    await channel.interrupt()
    await channel.close('end-thread')
    await h.drain()
    return { kind: 'ended' }
  }

  endAll(): Promise<Map<DwarfId, EndOutcome>> {
    throw new Error('Stop dwarf ends one dwarf, never through endAll')
  }
}

/** One Host: launching over the SimulatedDriver, crew with `stop`, the stop and launch routes, frames. */
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
  const sessions = {
    registry: suppliers.registry,
    channels: suppliers.sessions,
    bindings: suppliers.bindings
  }

  const launching = createLaunching({
    launches: db.launches,
    processes: db.processes,
    records: db.records,
    transactions: { inTransaction: (work) => db.inTransaction(work) },
    starter: createSessionStarter({
      launchDriver: suppliers.launchDriver,
      sessions: sessions.channels,
      clock,
      scheduler
    }),
    suppliers: {
      registry: suppliers.registry,
      launchDriver: suppliers.launchDriver,
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
    installId: '00000000-0000-7000-8000-0000000171ff',
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
    stopInFlight: (dwarfId) => crew.queries.get(dwarfId)?.stopInFlight,
    channelFor: (ref) => sessions.channels.sessionFor(ref),
    drain
  }))
  const stop = new CrewStop({
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

  const ui: Sent[] = []
  const attached: AttachedConnection = {
    role: 'ui',
    clientId: 'c-ui-171',
    send<F extends HostFrameName>(name: F, data: HostFrameData[F], seq: number): void {
      ui.push({ name, data, seq })
    },
    end: async () => undefined
  }
  connections.attach(attached)

  return {
    db,
    clock,
    bus,
    log,
    crew,
    conversation,
    launching,
    sessions,
    stop,
    terminator,
    delivered,
    ui,
    /** The last session the SimulatedDriver handed out, as the driver handed it out. */
    async lastRaw(): Promise<SimulatedSession> {
      const launched = handedOut.mock.results.at(-1)
      if (launched === undefined) throw new Error('the SimulatedDriver handed out no session')
      return (await launched.value) as SimulatedSession
    },
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
    /** Lets the event stream's pump hand the last events over. */
    drain
  }
}

type Host = ReturnType<typeof host>

/** How long a launch over the SimulatedDriver takes to settle: the early window and a margin. */
const SETTLE_MS = 3_200

/** Launches one dwarf through the Host and returns it with its launch and simulated session. */
async function launchedDwarf(
  h: Host
): Promise<{ dwarfId: DwarfId; launchId: LaunchId; session: SimulatedSession }> {
  const { launchId } = await h.launching.commands.launch({
    mineId: MINE,
    way: { kind: 'supplier', providerId: SIMULATED },
    prompt: PROMPT,
    jevOn: false,
    jevAutoAccept: false
  })
  await h.run(SETTLE_MS)
  const launched = h.bus.ofType('DwarfLaunched').find((e) => e.payload.launchId === launchId)
  if (launched === undefined) throw new Error('the launch did not land')
  const session = await h.lastRaw()
  return { dwarfId: launched.payload.dwarfId, launchId, session }
}

/** Opens a turn on the dwarf's session that has not finished yet. */
async function openTurn(h: Host, session: SimulatedSession): Promise<void> {
  const channel = h.sessions.channels.sessionFor(session.ref)
  if (channel === null) throw new Error('the launched session has no channel')
  h.crew.commands.recordActivity(h.bus.ofType('DwarfLaunched')[0]!.payload.dwarfId, 'turn-started')
  await channel.sendTurn({
    messageId: 'm-171' as MessageId,
    kind: 'message',
    text: 'Shore up the east wall too',
    attachments: []
  })
  await h.drain()
}

function framesNamed(sent: readonly Sent[], name: HostFrameName): Sent[] {
  return sent.filter((frame) => frame.name === name)
}

describe('stop dwarf (F9)', () => {
  it('[US-MSG-008.AC03, S15.13, S4.06] a confirmed stop ends the session and the dwarf departs stopped, with its conversation still in the mine history', async () => {
    const h = host()
    const { dwarfId, launchId } = await launchedDwarf(h)
    const rows = h.conversation.log.rowCount(dwarfId)
    expect(rows).toBeGreaterThan(0)

    const answer = await h.stop.stop(dwarfId, REQUEST)

    expect(answer).toEqual({ ok: true, value: undefined })
    expect(h.terminator.calls.map(({ dwarfId: id, why }) => ({ id, why }))).toEqual([
      { id: dwarfId, why: 'stop-dwarf' }
    ])
    expect(h.delivered.at(-1)).toMatchObject({ dwarfId, event: { t: 'exited' } })
    expect(framesNamed(h.ui, 'dwarf.departed').map((frame) => frame.data)).toEqual([
      { dwarfId, mineId: MINE, cause: 'stopped' }
    ])
    expect(h.crew.queries.get(dwarfId)).toMatchObject({
      departed: true,
      departureCause: 'stopped',
      processState: 'closed'
    })
    // S4.06: the owned session's record ends, stopped by the person, with no resume intent.
    expect(h.db.records.live()).toEqual([])
    expect(h.db.records.all()).toMatchObject([
      { dwarfId, launchId, stoppedByPerson: true, resumeIntent: false }
    ])
    // The conversation stays readable: nothing of it was dropped.
    expect(h.conversation.log.rowCount(dwarfId)).toBe(rows)
    expect(h.bus.ofType('DwarfStopFailed')).toEqual([])
  })

  it('[US-MSG-008.AC08, US-MSG-016.AC06, FM-140, S15.01] a stop while a turn is open ends the whole session, the turn ends interrupted from the app with no cue, and the dwarf walks out', async () => {
    const h = host()
    const { dwarfId, session } = await launchedDwarf(h)
    await openTurn(h, session)
    expect(h.crew.queries.get(dwarfId)?.status).toBe('working')
    const before = h.delivered.length

    const answer = await h.stop.stop(dwarfId, REQUEST)

    // Not refused for the open turn (AMENDMENT-2, OQ-54): the whole session ended.
    expect(answer).toEqual({ ok: true, value: undefined })
    const after = h.delivered.slice(before).map((delivery) => delivery.event)
    expect(after.map((event) => event.t)).toEqual(['turn.ended', 'status', 'exited'])
    expect(after[0]).toMatchObject({ end: { kind: 'interrupted', cancelledFromApp: true } })
    expect(h.sessions.channels.sessionFor(session.ref)).toBeNull()
    expect(framesNamed(h.ui, 'dwarf.departed').map((frame) => frame.data)).toEqual([
      { dwarfId, mineId: MINE, cause: 'stopped' }
    ])
    expect(framesNamed(h.ui, 'toast')).toEqual([])
  })

  it('[FM-060, S4.05] stopped_by_person is committed before the terminator runs, so the exit raises no crash toast', async () => {
    const h = host()
    const { dwarfId } = await launchedDwarf(h)

    await h.stop.stop(dwarfId, REQUEST)

    expect(h.terminator.calls).toEqual([
      { dwarfId, why: 'stop-dwarf', stoppedByPerson: true, stopInFlight: true }
    ])
    expect(h.bus.ofType('DwarfStopRequested').map((event) => event.payload)).toEqual([
      { dwarfId, requestId: REQUEST, why: 'stop-dwarf' }
    ])
    expect(h.bus.ofType('LaunchedSessionCrashed')).toEqual([])
    expect(framesNamed(h.ui, 'toast')).toEqual([])
    expect(h.log.byEvent('session.crashed')).toEqual([])
  })

  it('[FM-060] a throwing markStoppedByPerson makes the stop answer could-not-end and ends nothing', async () => {
    const h = host()
    const { dwarfId, session } = await launchedDwarf(h)
    // The `launch_records` write fails: the required handler throws inside the publish.
    h.db.records.markStoppedByPerson = () => {
      throw new Error('the launch_records write failed')
    }

    const answer = await h.stop.stop(dwarfId, REQUEST)

    expect(answer).toEqual({ ok: false, error: 'could-not-end' })
    expect(h.terminator.calls).toEqual([])
    expect(h.sessions.channels.sessionFor(session.ref)).not.toBeNull()
    expect(h.crew.queries.get(dwarfId)).toMatchObject({
      departed: false,
      stopInFlight: false,
      stopUnavailableReason: null
    })
    expect(framesNamed(h.ui, 'toast').map((frame) => frame.data)).toEqual([
      { kind: 'dwarf-stop-failed', requestId: REQUEST, dwarfId }
    ])
  })

  it('[US-MSG-008.AC07, FM-062, S15.15, S4.07] a session that cannot be ended leaves the dwarf present with its real status and one dwarf-stop-failed toast naming it', async () => {
    const h = host()
    const { dwarfId, session } = await launchedDwarf(h)
    await openTurn(h, session)
    h.terminator.script(dwarfId, { kind: 'failed', reason: 'still-alive' })

    const answer = await h.stop.stop(dwarfId, REQUEST)

    expect(answer).toEqual({ ok: false, error: 'could-not-end' })
    expect(h.crew.queries.get(dwarfId)).toMatchObject({
      departed: false,
      status: 'working',
      processState: 'running',
      stopInFlight: false,
      stopUnavailableReason: null,
      pendingEnd: null
    })
    expect(framesNamed(h.ui, 'dwarf.departed')).toEqual([])
    expect(framesNamed(h.ui, 'toast').map((frame) => frame.data)).toEqual([
      { kind: 'dwarf-stop-failed', requestId: REQUEST, dwarfId }
    ])
    expect(h.bus.ofType('DwarfStopFailed').map((event) => event.payload)).toEqual([
      { dwarfId, requestId: REQUEST, why: 'stop-dwarf', reason: 'could-not-end' }
    ])
    // Its process still runs: the session keeps its channel, and Stop dwarf is available again.
    expect(h.sessions.channels.sessionFor(session.ref)).not.toBeNull()
    // An end that could not even be attempted fails closed the same way (ADR-014 item 6).
    h.terminator.script(dwarfId, 'reject')
    expect(await h.stop.stop(dwarfId, '01890a5d-ac96-774b-bcce-000000001712')).toEqual({
      ok: false,
      error: 'could-not-end'
    })
    expect(framesNamed(h.ui, 'toast')).toHaveLength(2)
    expect(h.crew.queries.get(dwarfId)?.departed).toBe(false)
  })

  // ADDED for ISSUE-241 (TC-241-03; 21 §2 4b "Legacy deleted"; ADR-014 item 2; 15 §5 `no-identity`): with
  // `LegacyEndFirstAdapter` deleted, no legacy kill runs before `crew.stop`. A session the old app launched and that is
  // still running is an observed session of the Host, with no ProcessIdentity it may end, so the terminator answers
  // `failed: 'no-identity'` with nothing signalled (the real bridge's observed path, bridges/sessionTerminator.test.ts),
  // and Stop dwarf answers could-not-end with the dwarf left present. Characterization: the Host never depended on the
  // adapter, so there is no RED.
  it('[ADR-014] Stop dwarf on a still-running session the old app launched reports could-not-end with the no-identity cause', async () => {
    const h = host()
    const dwarfId = h.crew.commands.arrive({
      mineId: MINE,
      identity: {
        providerId: CATALOG_PROVIDER_IDS[3] as ProviderId,
        providerSessionId: 'ses-old-app'
      },
      rank: 'foreman',
      status: 'working'
    })
    h.terminator.script(dwarfId, { kind: 'failed', reason: 'no-identity' })

    const answer = await h.stop.stop(dwarfId, REQUEST)

    expect(answer).toEqual({ ok: false, error: 'could-not-end' })
    expect(h.terminator.calls.map((call) => [call.dwarfId, call.why])).toEqual([
      [dwarfId, 'stop-dwarf']
    ])
    expect(h.crew.queries.get(dwarfId)).toMatchObject({ departed: false, stopInFlight: false })
    expect(framesNamed(h.ui, 'dwarf.departed')).toEqual([])
    expect(h.bus.ofType('DwarfStopFailed').map((event) => event.payload)).toEqual([
      { dwarfId, requestId: REQUEST, why: 'stop-dwarf', reason: 'could-not-end' }
    ])
  })

  it('[US-MSG-008.AC05, BR-11, INV-26] a dwarf whose process has not closed never departs with time alone', async () => {
    const h = host()
    const { dwarfId, session } = await launchedDwarf(h)
    h.terminator.script(dwarfId, 'hang')

    let answered = false
    void h.stop.stop(dwarfId, REQUEST).then(() => {
      answered = true
    })
    await h.run(120_000)

    expect(answered).toBe(false)
    expect(h.crew.queries.get(dwarfId)).toMatchObject({
      departed: false,
      processState: 'running',
      stopUnavailableReason: 'already-stopping'
    })
    expect(framesNamed(h.ui, 'dwarf.departed')).toEqual([])
    // A second Stop dwarf meanwhile is refused, never a second end.
    expect(await h.stop.stop(dwarfId, '01890a5d-ac96-774b-bcce-000000001713')).toEqual({
      ok: false,
      error: 'already-stopping'
    })
    expect(h.terminator.calls).toHaveLength(1)
    // The process closing is what departs it (INV-26).
    await session.close('end-thread')
    await h.drain()
    expect(framesNamed(h.ui, 'dwarf.departed').map((frame) => frame.data)).toEqual([
      { dwarfId, mineId: MINE, cause: 'stopped' }
    ])
  })

  it('[US-MSG-008.AC06, S7.07, BR-03] a message still sending when the session ends settles session-closed and the chat becomes read-only', async () => {
    const h = host()
    const { dwarfId, session } = await launchedDwarf(h)
    await openTurn(h, session)
    const channel = h.sessions.channels.sessionFor(session.ref)
    if (channel === null) throw new Error('the launched session has no channel')

    await h.stop.stop(dwarfId, REQUEST)

    // Nothing more can be sent: the delivery settles session-closed (15 §1.3).
    await expect(
      channel.sendTurn({
        messageId: 'm-171-2' as MessageId,
        kind: 'message',
        text: 'Still there?',
        attachments: []
      })
    ).rejects.toMatchObject({ kind: 'session-closed' })
    // The panel stays open read-only: the dwarf is departed, readable, and cannot receive messages.
    expect(h.crew.queries.get(dwarfId)).toMatchObject({ departed: true, canReceiveMessages: false })
    expect(h.conversation.log.rowCount(dwarfId)).toBeGreaterThan(0)
  })

  it('[FM-061] a dwarf whose turn never ends stays working with Stop dwarf available, and Stop dwarf ends it with one departure, no crash toast and its provider process gone', async () => {
    const h = host()
    const { dwarfId, session } = await launchedDwarf(h)
    await openTurn(h, session)
    // The provider never finishes the turn: no time passes for its scheduled steps to run.
    await h.drain()
    expect(h.crew.queries.get(dwarfId)).toMatchObject({
      status: 'working',
      stopUnavailableReason: null
    })

    expect(await h.stop.stop(dwarfId, REQUEST)).toEqual({ ok: true, value: undefined })

    expect(framesNamed(h.ui, 'dwarf.departed')).toHaveLength(1)
    expect(framesNamed(h.ui, 'toast')).toEqual([])
    expect(h.bus.ofType('LaunchedSessionCrashed')).toEqual([])
    expect(h.sessions.channels.sessionFor(session.ref)).toBeNull()
    expect(h.delivered.filter((d) => d.event.t === 'exited')).toHaveLength(1)
  })
})
