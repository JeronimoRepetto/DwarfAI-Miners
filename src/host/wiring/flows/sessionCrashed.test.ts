// layer: L2
// L2 flow (17 §1.2; UC-021; 13 FM-058, FM-060, FM-069): an owned session that dies on its own,
// composed as the Host composes it — the launching module over its in-memory stores, launched
// through the `SessionStarter` bridge over the suppliers module's SimulatedDriver (15 §4.12),
// whose event sink is the `DriverSessionExited` route (routes/launching.ts `routeSessionExits`),
// as the composition root will hand it over (later: ISSUE-182); crew over its in-memory doubles; the launching routes and crew's board
// frames on one connection registry that checks every frame against its 14 §3.5 schema. FakeClock,
// FakeScheduler, RecordingEventBus: no real time, no process, no disk.
//
// The simulated session is observed as the driver hands it out (a call-through spy), so a test can end it without the
// Host asking (the provider process ending by itself) or drop its transport (C-18). What "Stop
// dwarf…" leaves behind before its end runs (07 S15.01: `stopped_by_person = 1`, then the pending
// `why`) is arranged directly: its command and its owned end are ISSUE-171's and ISSUE-175's.
//
// TC-176-01 (an unstopped owned exit: one LaunchedSessionCrashed, one toast, departs crashed) and
// TC-176-02 (no toast for a dwarf the current Host recovery covers).
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
import { inMemoryCrew } from '../../modules/crew/testing/inMemoryCrew'
import { rankForDepth, type EndReason } from '../../modules/crew'
import { createLaunching, type LaunchingEvent } from '../../modules/launching'
import { inMemoryLaunching } from '../../modules/launching/testing/inMemoryLaunching'
import type { MineView } from '../../modules/mines'
import {
  createSuppliers,
  type DriverLaunchRequest,
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
import { routeLaunching, routeSessionExits } from '../routes/launching'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-176' as HostEpoch
const MINE = '00000000-0000-7000-8000-0000000176a1' as MineId
const FOLDER = '/work/deep-seam' as FolderPath
const SIMULATED = 'simulated' as ProviderId
const PROMPT = 'Shore up the deep seam'
const SEED = 'seed-176'

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
  seq: number
}

/**
 * Every session the SimulatedDriver hands out, observed as it leaves the driver (the call goes
 * through unchanged): suppliers keeps the driver's session to itself, and a test needs it to end
 * the process without the Host or to drop its transport (C-18).
 */
let handedOut: MockInstance<SimulatedDriver['launch']>
beforeEach(() => {
  handedOut = vi.spyOn(SimulatedDriver.prototype, 'launch')
})
afterEach(() => {
  handedOut.mockRestore()
})

/** One Host: launching over the bridge and the suppliers module's SimulatedDriver, crew, frames. */
function host() {
  const db = inMemoryLaunching(T0)
  const clock = db.clock
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const bus = new RecordingEventBus<LaunchingEvent>()
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

  const covered = new Set<DwarfId>()
  const launching = createLaunching({
    launches: db.launches,
    processes: db.processes,
    records: db.records,
    transactions: { inTransaction: (work) => db.inTransaction(work) },
    starter: createSessionStarter({
      registry: sessions.registry,
      sessions: sessions.channels,
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
    installId: '00000000-0000-7000-8000-0000000176ff',
    log,
    recovery: { covers: (dwarfId) => covered.has(dwarfId) }
  })
  // Crew's pending `why` of a Host-requested end is Host memory its stores never keep; the end
  // that records it (`SessionTerminator.end(dwarfId, why)` from "Stop dwarf…") is ISSUE-171's, so
  // the test holds it here and the route reads it through `CrewQueries.get`, as it will then.
  const pending = new Map<DwarfId, EndReason>()
  exits = routeSessionExits({
    launching,
    crew: {
      queries: {
        get: (dwarfId) => {
          const view = crew.queries.get(dwarfId)
          const why = pending.get(dwarfId)
          return view === null || why === undefined ? view : { ...view, pendingEnd: why }
        }
      },
      commands: crew.commands
    }
  })

  const connections = new ConnectionRegistry({ validateFrame })
  routeLaunching({
    events: bus,
    launching,
    conversation: conversation.commands,
    frames: connections
  })
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
    clientId: 'c-ui-176',
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
    launching,
    sessions,
    /** The last session the SimulatedDriver handed out, as the driver handed it out. */
    async lastRaw(): Promise<SimulatedSession> {
      const launched = handedOut.mock.results.at(-1)
      if (launched === undefined) throw new Error('the SimulatedDriver handed out no session')
      return (await launched.value) as SimulatedSession
    },
    delivered,
    covered,
    pending,
    ui,
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
    async drain(): Promise<void> {
      for (let i = 0; i < 50; i += 1) await Promise.resolve()
    }
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

/** What "Stop dwarf…" leaves before its end runs (07 S15.01): stopped by the person, `why` pending. */
function stopRequested(h: Host, dwarfId: DwarfId, why: EndReason = 'stop-dwarf'): void {
  h.db.inTransaction(() => h.db.records.markStoppedByPerson(dwarfId))
  h.pending.set(dwarfId, why)
}

function framesNamed(sent: readonly Sent[], name: HostFrameName): Sent[] {
  return sent.filter((frame) => frame.name === name)
}

describe('an owned session dies on its own', () => {
  it('[US-RES-001.AC02, S4.08, FM-058] an unstopped launched dwarf whose process exits departs crashed and one toast frame names it stopped unexpectedly', async () => {
    const h = host()
    const { dwarfId, launchId, session } = await launchedDwarf(h)

    // The provider process ends by itself: nothing in the Host asked for it.
    await session.close('end-thread')
    await h.drain()

    expect(h.delivered.at(-1)).toMatchObject({ dwarfId, event: { t: 'exited', code: 0 } })
    expect(h.bus.ofType('LaunchedSessionCrashed').map((e) => e.payload)).toEqual([
      { dwarfId, launchId }
    ])
    const toasts = framesNamed(h.ui, 'toast')
    expect(toasts.map((frame) => frame.data)).toEqual([
      { kind: 'session-crashed', dwarfId, launchId }
    ])
    const departed = framesNamed(h.ui, 'dwarf.departed')
    expect(departed.map((frame) => frame.data)).toEqual([
      { dwarfId, mineId: MINE, cause: 'crashed' }
    ])
    // S2.07: the departure follows LaunchedSessionCrashed.
    expect(toasts[0]!.seq).toBeLessThan(departed[0]!.seq)
    expect(h.crew.queries.get(dwarfId)).toMatchObject({ departed: true, departureCause: 'crashed' })
    // The owned session's record ends, with no resume intent left (09 §4.3; ADR-015 item 8).
    expect(h.db.records.live()).toEqual([])
    expect(h.db.records.all()).toMatchObject([
      { dwarfId, launchId, endedAt: T0 + SETTLE_MS, resumeIntent: false, stoppedByPerson: false }
    ])
    expect(h.log.byEvent('session.crashed')).toMatchObject([
      { level: 'warn', subsystem: 'launching', dwarfId, launchId }
    ])
  })

  it('[US-OBS-007.AC07, BR-08] the same exit of an observed dwarf departs closed-elsewhere with no toast', async () => {
    const h = host()
    // A dwarf launching does not own (no live LaunchRecord, INV-30) whose session the driver holds.
    const dwarfId = h.crew.commands.arrive({
      mineId: MINE,
      identity: { providerId: SIMULATED, providerSessionId: 'observed-176' },
      rank: rankForDepth(0),
      status: 'idle'
    })
    const tracked = h.sessions.registry.drivers(SIMULATED)[0]!
    const req: DriverLaunchRequest = {
      launchId: '00000000-0000-7000-8000-0000000176b1' as LaunchId,
      install: {
        providerId: SIMULATED,
        binaryPath: 'simulated:simulated',
        version: 'simulated',
        resolvedVia: 'path',
        statMtimeMs: 0
      },
      cwd: FOLDER,
      prompt: PROMPT,
      permissionMode: null,
      delegation: null,
      spawnTag: 'v1:observed',
      onSpawned: async () => undefined
    }
    const opened = tracked.launch(req)
    await h.run(100)
    const shared = await opened
    h.sessions.bindings.bind(shared.ref, dwarfId)

    await (await h.lastRaw()).close('end-thread')
    await h.drain()

    expect(h.delivered.at(-1)).toMatchObject({ dwarfId, event: { t: 'exited', code: 0 } })
    expect(h.bus.ofType('LaunchedSessionCrashed')).toEqual([])
    expect(framesNamed(h.ui, 'toast')).toEqual([])
    expect(framesNamed(h.ui, 'dwarf.departed').map((frame) => frame.data)).toEqual([
      { dwarfId, mineId: MINE, cause: 'closed-elsewhere' }
    ])
    expect(h.log.byEvent('session.crashed')).toEqual([])
  })

  it('[US-RES-001.AC04, FM-060] a dwarf stopped through Stop dwarf first departs stopped with no toast', async () => {
    const h = host()
    const { dwarfId, launchId, session } = await launchedDwarf(h)
    stopRequested(h, dwarfId)

    // The end the person asked for closes the session.
    await session.close('end-thread')
    await h.drain()

    expect(h.bus.ofType('LaunchedSessionCrashed')).toEqual([])
    expect(framesNamed(h.ui, 'toast')).toEqual([])
    expect(framesNamed(h.ui, 'dwarf.departed').map((frame) => frame.data)).toEqual([
      { dwarfId, mineId: MINE, cause: 'stopped' }
    ])
    expect(h.db.records.all()).toMatchObject([
      { dwarfId, launchId, endedAt: T0 + SETTLE_MS, resumeIntent: false, stoppedByPerson: true }
    ])
  })

  it('[US-RES-001.AC04, FM-060] a dwarf whose Stop dwarf end failed raises no toast when its process later closes', async () => {
    const h = host()
    const { dwarfId, session } = await launchedDwarf(h)
    stopRequested(h, dwarfId)
    // S2.15: the end failed, so the pending `why` is forgotten; `stopped_by_person` stays.
    h.pending.delete(dwarfId)

    await session.close('end-thread')
    await h.drain()

    expect(h.bus.ofType('LaunchedSessionCrashed')).toEqual([])
    expect(framesNamed(h.ui, 'toast')).toEqual([])
    expect(h.crew.queries.get(dwarfId)).toMatchObject({ departed: true })
    expect(h.db.records.live()).toEqual([])
  })

  it("[US-RES-001.AC03, S7.07] a message still sending when the process dies settles session-closed and the dwarf's chat becomes read-only, in addition to the toast", async () => {
    const h = host()
    const { dwarfId, launchId, session } = await launchedDwarf(h)
    const channel = h.sessions.channels.sessionFor(session.ref)
    if (channel === null) throw new Error('the launched session has no channel')
    // A turn is open: its reply has not come back yet when the process dies.
    await channel.sendTurn({
      messageId: 'm-176' as MessageId,
      kind: 'message',
      text: 'Check the props',
      attachments: []
    })
    await h.drain()
    const before = h.delivered.length

    session.simulateTransportLoss()
    await h.drain()
    await h.run(100)

    // The open turn never finishes, and nothing more can be sent: the session is closed.
    const after = h.delivered.slice(before).map((delivery) => delivery.event.t)
    expect(after).toEqual(['error', 'exited'])
    await expect(
      channel.sendTurn({
        messageId: 'm-176-2' as MessageId,
        kind: 'message',
        text: 'Still there?',
        attachments: []
      })
    ).rejects.toMatchObject({ kind: 'session-closed' })
    expect(h.sessions.channels.sessionFor(session.ref)).toBeNull()
    // The window keeps the panel open, read-only, from the departure (PO #23), and the toast shows.
    expect(framesNamed(h.ui, 'dwarf.departed').map((frame) => frame.data)).toEqual([
      { dwarfId, mineId: MINE, cause: 'crashed' }
    ])
    expect(h.crew.queries.get(dwarfId)).toMatchObject({ canReceiveMessages: false })
    expect(framesNamed(h.ui, 'toast').map((frame) => frame.data)).toEqual([
      { kind: 'session-crashed', dwarfId, launchId }
    ])
  })

  it('[ADR-015] no toast is published for a dwarf resumed or listed by the current Host recovery', async () => {
    const h = host()
    const recovered = await launchedDwarf(h)
    const other = await launchedDwarf(h)
    h.covered.add(recovered.dwarfId)

    await recovered.session.close('end-thread')
    await other.session.close('end-thread')
    await h.drain()

    // Only the dwarf the recovery does not cover is reported.
    expect(h.bus.ofType('LaunchedSessionCrashed').map((e) => e.payload)).toEqual([
      { dwarfId: other.dwarfId, launchId: other.launchId }
    ])
    expect(framesNamed(h.ui, 'toast').map((frame) => frame.data)).toEqual([
      { kind: 'session-crashed', dwarfId: other.dwarfId, launchId: other.launchId }
    ])
    // The recovery keeps its dwarf in its mine (OQ-41 A) and owns its record.
    expect(framesNamed(h.ui, 'dwarf.departed').map((frame) => frame.data)).toEqual([
      { dwarfId: other.dwarfId, mineId: MINE, cause: 'crashed' }
    ])
    expect(h.crew.queries.get(recovered.dwarfId)).toMatchObject({ departed: false })
    expect(h.db.records.live()).toMatchObject([{ dwarfId: recovered.dwarfId, resumeIntent: true }])
  })

  it('[FM-069] a transport loss without an exit yields error transport-lost then the same crash path', async () => {
    const h = host()
    const { dwarfId, launchId, session } = await launchedDwarf(h)
    const before = h.delivered.length

    session.simulateTransportLoss()
    await h.drain()

    expect(h.delivered.slice(before).map((delivery) => delivery.event)).toEqual([
      { t: 'error', cause: { kind: 'transport-lost', detail: 'simulated transport loss' } },
      { t: 'exited', code: null }
    ])
    expect(h.bus.ofType('LaunchedSessionCrashed').map((e) => e.payload)).toEqual([
      { dwarfId, launchId }
    ])
    expect(framesNamed(h.ui, 'toast').map((frame) => frame.data)).toEqual([
      { kind: 'session-crashed', dwarfId, launchId }
    ])
    expect(framesNamed(h.ui, 'dwarf.departed').map((frame) => frame.data)).toEqual([
      { dwarfId, mineId: MINE, cause: 'crashed' }
    ])
    expect(h.db.records.live()).toEqual([])
  })
})
