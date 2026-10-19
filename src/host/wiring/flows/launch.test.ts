// layer: L2
// L2 flow F3 (17 §1.2; 11 F3; UC-008, UC-011, UC-022, UC-024): "Send the dwarf in" through the
// Host, composed as wiring/routes/launching.ts composes it — the launching module over its
// in-memory stores, the `SessionStarter` bridge over the suppliers module's registry with the
// SimulatedDriver (15 §4.12), crew and conversation over their in-memory doubles, the launch
// routes and frames, the `launches` snapshot section, B-M33 on the seam-B dispatcher, and the
// connection registry with every frame checked against its 14 §3.5 schema. The failure paths whose
// tool output the SimulatedDriver cannot produce run the same composition over the
// `FakeSessionStarter`, which passes the same contract as the bridge (16 §2.8). FakeClock,
// FakeScheduler and a RecordingEventBus: no real time, no process, no disk.
//
// TC-162-01 (answer at acceptance, settlement by frames), TC-162-02 (the `processes` row before the
// handshake), TC-162-03 (a failure no UI saw is never shown).
import { describe, expect, it } from 'vitest'
import {
  CATALOG_PROVIDER_IDS,
  HOST_FRAME_SCHEMAS,
  type HostFrameData,
  type HostFrameName
} from '@dwarfai/contracts'
import type {
  FolderPath,
  HostEpoch,
  LaunchId,
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
import {
  createLaunching,
  LaunchRefusedError,
  type LaunchingEvent,
  type LaunchRequestInput,
  type SessionStarter
} from '../../modules/launching'
import { createLaunchDrainGate } from '../../modules/launching'
import { FakeSessionStarter } from '../../modules/launching/testing/FakeSessionStarter'
import { inMemoryLaunching } from '../../modules/launching/testing/inMemoryLaunching'
import type { MineView } from '../../modules/mines'
import { createSuppliers, type SuppliedEventDelivery } from '../../modules/suppliers'
import { ConnectionRegistry, type AttachedConnection } from '../../transport/connectionRegistry'
import { Dispatcher } from '../../transport/dispatcher'
import { registerLaunchingLaunch } from '../../transport/methods/launchingLaunch'
import { registerLaunchesSection } from '../../transport/snapshot/launchesSection'
import { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { createSessionStarter } from '../bridges/sessionStarter'
import { routeLaunching } from '../routes/launching'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-162' as HostEpoch
const MINE = '00000000-0000-7000-8000-0000000162a1' as MineId
const UNENTERABLE = '00000000-0000-7000-8000-0000000162a2' as MineId
const REMOVED = '00000000-0000-7000-8000-0000000162a3' as MineId
const MISSING = '00000000-0000-7000-8000-0000000162a4' as MineId
const FOLDER = '/work/north-seam' as FolderPath
const SIMULATED = 'simulated' as ProviderId
const PROMPT = 'Survey the north seam and mark the face'

const REQUEST: LaunchRequestInput = {
  mineId: MINE,
  way: { kind: 'supplier', providerId: SIMULATED },
  prompt: PROMPT,
  jevOn: false,
  jevAutoAccept: false
}

function mineView(id: MineId, state: MineView['state']): MineView {
  return {
    id,
    path: FOLDER as unknown as MineView['path'],
    name: 'north-seam' as MineView['name'],
    state,
    tier: null,
    sourceWeight: null,
    hasBeenMeasured: false,
    ...(state === 'unenterable' ? { unenterableReason: 'not-found' } : {}),
    ...(state === 'removed' ? { removedAt: T0 } : {}),
    createdAt: T0,
    lastUsedAt: T0,
    presentDwarfs: 0
  }
}

const MINES: ReadonlyMap<MineId, MineView> = new Map([
  [MINE, mineView(MINE, 'active')],
  [UNENTERABLE, mineView(UNENTERABLE, 'unenterable')],
  [REMOVED, mineView(REMOVED, 'removed')]
])

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

/** One attached connection that records what it was written. */
function connection(role: AttachedConnection['role'], clientId: string) {
  const sent: Sent[] = []
  const attached: AttachedConnection = {
    role,
    clientId,
    send<F extends HostFrameName>(name: F, data: HostFrameData[F], seq: number): void {
      sent.push({ name, data, seq })
    },
    end: async () => undefined
  }
  return { attached, sent }
}

/** One Host: launching, the bridge over suppliers (or the double), crew, conversation, frames. */
function host(
  options: {
    starter?: 'bridge' | 'fake'
    /** The mode ids the supplier's entry offers now (ADR-011 item 1); none by default. */
    offeredModes?: readonly string[]
    /** Makes the `launch_records` write throw: a failure after the dwarf arrived. */
    failRecordsWrite?: boolean
  } = {}
) {
  const db = inMemoryLaunching(T0)
  const clock = db.clock
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const bus = new RecordingEventBus<LaunchingEvent>()
  const crew = inMemoryCrew()
  const conversation = inMemoryConversation()
  const delivered: SuppliedEventDelivery[] = []
  const suppliers = createSuppliers({
    catalogIds: CATALOG_PROVIDER_IDS as unknown as ProviderId[],
    publicBuild: false,
    clock,
    scheduler,
    simulatedSeed: 'seed-162',
    sink: { deliver: (delivery) => delivered.push(delivery) },
    installResolver: { resolve: async () => null },
    fs: new FakeFs(),
    capabilityRecords: { record: () => undefined, latest: () => null },
    integrationGate: { state: () => 'off' },
    bus: { publish: () => undefined },
    ids,
    hostEpoch: EPOCH
  })
  const fake = new FakeSessionStarter({
    clock,
    scheduler,
    supplierLabel: 'Simulated',
    capabilities: suppliers.catalogue.capabilities(SIMULATED)
  })
  const starter: SessionStarter =
    options.starter === 'fake'
      ? fake
      : createSessionStarter({
          launchDriver: suppliers.launchDriver,
          sessions: suppliers.sessions,
          clock,
          scheduler
        })
  const launching = createLaunching({
    launches: db.launches,
    processes: db.processes,
    records: options.failRecordsWrite
      ? {
          ...db.records,
          all: () => db.records.all(),
          live: () => db.records.live(),
          remove: (id) => db.records.remove(id),
          markStoppedByPerson: (id) => db.records.markStoppedByPerson(id),
          put: () => {
            throw new Error('the launch_records write failed')
          }
        }
      : db.records,
    transactions: { inTransaction: (work) => db.inTransaction(work) },
    starter,
    suppliers: {
      registry: suppliers.registry,
      launchDriver: suppliers.launchDriver,
      catalogue: {
        entry: (id) => {
          const entry = suppliers.catalogue.entry(id)
          return entry === null || options.offeredModes === undefined
            ? entry
            : { ...entry, permissionModes: [...options.offeredModes] }
        }
      },
      // The double hands out sessions suppliers never saw: only the bridge's can be bound.
      bindings: options.starter === 'fake' ? { bind: () => undefined } : suppliers.bindings
    },
    mines: {
      get: (id) => MINES.get(id) ?? null,
      folderOf: (id) => (MINES.has(id) ? FOLDER : null)
    },
    crew: crew.commands,
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH,
    installId: '00000000-0000-7000-8000-0000000162ff',
    log
  })
  const connections = new ConnectionRegistry({ validateFrame })
  routeLaunching({
    events: bus,
    launching,
    conversation: conversation.commands,
    frames: connections
  })
  const sections = new SectionRegistry()
  registerLaunchesSection(sections, { launches: launching.snapshots })
  const dispatcher = new Dispatcher({ log, clock, scheduler, state: () => 'ready' })
  registerLaunchingLaunch(dispatcher, { launching: launching.commands })

  return {
    db,
    clock,
    suppliers,
    bus,
    log,
    crew,
    conversation,
    fake,
    launching,
    connections,
    dispatcher,
    delivered,
    /** Attaches a connection of `role` and returns what it is written. */
    attach(role: AttachedConnection['role'] = 'ui', clientId = `c-${role}-${ids.uuidv7()}`) {
      const made = connection(role, clientId)
      connections.attach(made.attached)
      return made
    },
    /** The `launches` section as a snapshot built now reads it. */
    launchesSection(): unknown[] {
      const section = sections.get('launches')
      if (section === undefined) throw new Error('the launches section is not registered')
      return section.provider() as unknown[]
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
    }
  }
}

type Host = ReturnType<typeof host>

function frames(sent: readonly Sent[], name: HostFrameName): unknown[] {
  return sent.filter((frame) => frame.name === name).map((frame) => frame.data)
}

/** How long a launch over the SimulatedDriver takes to settle: the early window and a margin. */
const SETTLE_MS = 3_200

async function launched(h: Host, input: LaunchRequestInput = REQUEST): Promise<LaunchId> {
  const { launchId } = await h.launching.commands.launch(input)
  return launchId
}

describe('launch flow F3 (SimulatedDriver)', () => {
  it('[US-LAUNCH-005.AC07, S5.21, S4.02] a successful launch publishes DwarfLaunched and the dwarf arrives with the prompt as its first message', async () => {
    const h = host()
    const ui = h.attach()
    const launchId = await launched(h)
    await h.run(SETTLE_MS)

    const [event] = h.bus.ofType('DwarfLaunched')
    expect(event?.payload).toMatchObject({
      launchId,
      mineId: MINE,
      delegated: false,
      prompt: PROMPT
    })
    const dwarfId = event?.payload.dwarfId
    const crew = h.crew.queries.crewOf(MINE)
    expect(crew.map((dwarf) => [dwarf.id, dwarf.status])).toEqual([[dwarfId, 'working']])
    const appended = h.conversation.bus.ofType('MessagesAppended')
    expect(appended.map((e) => [e.payload.dwarfId, e.payload.messages.map((m) => m.text)])).toEqual(
      [[dwarfId, [PROMPT]]]
    )
    expect(h.db.launches.byId(launchId)).toMatchObject({ state: 'succeeded', dwarfId })
    expect(h.db.records.live()).toMatchObject([{ dwarfId, launchId, resumeIntent: true }])
    expect(
      frames(ui.sent, 'launch.changed').map(
        (data) => (data as { launch: { state: string } }).launch.state
      )
    ).toEqual(['resolving', 'succeeded'])
    expect(h.launchesSection()).toEqual([])
    expect(h.log.byEvent('uncaught')).toEqual([])
  })

  it('[US-LAUNCH-005.AC05, US-LAUNCH-005.AC06, NFR-TIM-07] launch answers LaunchAccepted at acceptance and settles only by events, with no timer deciding when', async () => {
    const h = host()
    const ui = h.attach()
    let res: Awaited<ReturnType<typeof h.dispatcher.dispatch>> | undefined
    void h.dispatcher
      .dispatch(
        {
          id: '1',
          method: 'launching.launch',
          params: { ...REQUEST, requestId: '01890a5d-ac96-774b-bcce-b302099a8162' }
        },
        { role: 'ui', clientId: ui.attached.clientId }
      )
      .then((answer) => {
        res = answer
      })
    // The answer comes without the clock moving: no handshake, no spawn has happened yet.
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    // The answer came at acceptance: the row is committed, the launch is in flight, and its
    // `launch.changed` frame was written before the answer (14 §1.7).
    expect(res).toMatchObject({ ok: true, result: { launchId: expect.any(String) } })
    if (res === undefined || !res.ok) throw new Error('launching.launch was not answered')
    const { launchId } = res.result as { launchId: LaunchId }
    expect(h.db.launches.byId(launchId)?.state).toBe('resolving')
    expect(frames(ui.sent, 'launch.changed')).toHaveLength(1)
    expect(h.bus.ofType('DwarfLaunched')).toEqual([])

    // The settlement is an event, when the session actually started (handshake + early window).
    await h.run(SETTLE_MS - 400)
    expect(h.bus.ofType('DwarfLaunched')).toEqual([])
    await h.run(400)
    expect(h.bus.ofType('DwarfLaunched')).toHaveLength(1)
    expect(frames(ui.sent, 'launch.changed')).toHaveLength(2)
  })

  it('[S4.01, C-29] the processes row of a spawned launch is written in onSpawned, before its handshake completes', async () => {
    const h = host()
    const launchId = await launched(h)
    await h.run(20) // spawned; the SimulatedDriver's handshake answers 50 ms after its spawn
    expect(h.db.launches.byId(launchId)?.state).toBe('spawned')
    expect(h.db.processes.live()).toMatchObject([
      { purpose: 'session', launchId, hostEpoch: EPOCH }
    ])
    expect(h.bus.ofType('DwarfLaunched')).toEqual([])
  })

  it('[US-LAUNCH-005.AC01, S5.24, BR-22] closing the Add panel or detaching every UI never cancels a launch in flight', async () => {
    const h = host()
    const first = h.attach()
    const second = h.attach()
    const launchId = await launched(h)
    // Closing the Add panel sends nothing to the Host (UC-008 S5.08c); closing the window detaches.
    h.connections.detach(first.attached)
    h.connections.detach(second.attached)
    await h.run(SETTLE_MS)
    expect(h.db.launches.byId(launchId)?.state).toBe('succeeded')
    expect(h.bus.ofType('DwarfLaunched')).toHaveLength(1)
    expect(h.db.records.live()).toHaveLength(1)
  })

  it('[US-RES-003.AC05, S5.24] a launch settled while no UI was attached shows its dwarf working on the next attach', async () => {
    const h = host()
    const window = h.attach()
    await launched(h)
    h.connections.detach(window.attached)
    await h.run(SETTLE_MS)
    h.attach()
    const [dwarf] = h.crew.queries.crewOf(MINE)
    expect(dwarf?.status).toBe('working')
    expect(h.launchesSection()).toEqual([])
  })

  it('[ADR-002, S12.14] an in-flight launch holds the upgrade drain until it settles', async () => {
    const h = host()
    const gate = createLaunchDrainGate({ launches: h.launching.queries })
    expect(gate.blockers()).toEqual([])
    await launched(h)
    expect(gate.blockers()).toEqual([{ kind: 'in-flight' }])
    await h.run(SETTLE_MS)
    expect(gate.blockers()).toEqual([])
  })

  it('[ADR-011, INV-42] a permission mode the Host cannot hand to the driver is refused, never accepted and dropped', async () => {
    const h = host({ offeredModes: ['ask-first'] })
    await expect(
      h.launching.commands.launch({ ...REQUEST, permissionMode: 'ask-first' })
    ).rejects.toBeInstanceOf(LaunchRefusedError)
    expect(h.db.launches.snapshot().size).toBe(0)
    expect(h.bus.published).toEqual([])
  })

  it('[INV-52, S5.21] a launch whose owned-session write fails settles could-not-start, its dwarf walks out and its session is ended', async () => {
    const h = host({ failRecordsWrite: true })
    const ui = h.attach()
    const launchId = await launched(h)
    await h.run(SETTLE_MS)
    expect(h.db.launches.byId(launchId)).toMatchObject({
      state: 'failed',
      failure: { cause: 'could-not-start' }
    })
    expect(frames(ui.sent, 'launch.failed')).toHaveLength(1)
    expect(h.bus.ofType('DwarfLaunched')).toEqual([])
    // The dwarf that arrived for it is gone again, and its session is no longer live.
    expect(h.crew.queries.crewOf(MINE)).toEqual([])
    const [arrived] = h.crew.bus.ofType('DwarfArrived')
    expect(h.crew.bus.ofType('DwarfDeparted').map((e) => e.payload.dwarfId)).toEqual([
      arrived?.payload.dwarfId
    ])
    const ref = {
      providerId: SIMULATED,
      providerSessionId: arrived?.payload.identity.providerSessionId ?? ''
    }
    expect(h.suppliers.sessions.sessionFor(ref)).toBeNull()
    expect(h.db.records.live()).toEqual([])
  })

  it('[INV-50] a launch with no supplier, custom command or Jev, an empty prompt, or a mine that is missing or not enterable is refused before any launches row is written and publishes no LaunchRequested', async () => {
    const h = host()
    const refused: LaunchRequestInput[] = [
      { ...REQUEST, way: { kind: 'supplier', providerId: 'no-such-supplier' as ProviderId } },
      { ...REQUEST, way: { kind: 'jev' }, jevOn: true },
      { ...REQUEST, prompt: '   ' },
      { ...REQUEST, mineId: MISSING },
      { ...REQUEST, mineId: UNENTERABLE },
      { ...REQUEST, mineId: REMOVED },
      { ...REQUEST, permissionMode: 'ask-first' }
    ]
    for (const input of refused) {
      await expect(h.launching.commands.launch(input)).rejects.toBeInstanceOf(LaunchRefusedError)
    }
    await h.run(SETTLE_MS)
    expect(h.db.launches.inFlight()).toEqual([])
    expect(h.db.launches.snapshot().size).toBe(0)
    expect(h.bus.published).toEqual([])
  })
})

describe('launch flow F3, failures (FakeSessionStarter)', () => {
  it('[US-LAUNCH-006.AC06, INV-54] Retry of a failed launch sends the identical request as a new launch with retryOf', async () => {
    const h = host({ starter: 'fake' })
    h.attach()
    h.fake.arrange({ kind: 'rejects', cause: 'could-not-start' })
    const failed = await launched(h)
    await h.run(SETTLE_MS)
    expect(h.db.launches.byId(failed)?.state).toBe('failed')

    const retry = await launched(h, { ...REQUEST, retryOf: failed })
    await h.run(SETTLE_MS)
    expect(retry).not.toBe(failed)
    const [first, second] = h.bus.ofType('LaunchRequested')
    expect(second?.payload.request).toEqual(first?.payload.request)
    expect(h.db.launches.byId(retry)).toMatchObject({ retryOf: failed, state: 'succeeded' })
    // The driver request is the same but for the new attempt's own launch id, tag and callback.
    const sameRequest = (start: (typeof h.fake.starts)[number] | undefined): unknown =>
      Object.fromEntries(
        Object.entries(start?.req ?? {}).filter(
          ([key]) => !['launchId', 'spawnTag', 'onSpawned'].includes(key)
        )
      )
    const [a, b] = h.fake.starts
    expect(sameRequest(b)).toEqual(sameRequest(a))
    expect(sameRequest(a)).toMatchObject({ prompt: PROMPT, cwd: FOLDER })
    // The retried failure leaves the board (14 §4.3 rule 7).
    expect(h.launchesSection()).toEqual([])
    expect(h.log.byEvent('uncaught')).toEqual([])
  })

  it('[US-LAUNCH-006.AC09] a failed launch never retries by itself however long the FakeClock advances', async () => {
    const h = host({ starter: 'fake' })
    h.attach()
    h.fake.arrange({ kind: 'exits-in-window' })
    const launchId = await launched(h)
    await h.run(SETTLE_MS)
    expect(h.db.launches.byId(launchId)?.state).toBe('failed')
    h.clock.advance(24 * 3_600_000)
    await h.run(10)
    expect(h.fake.starts).toHaveLength(1)
    expect(h.bus.ofType('LaunchRequested')).toHaveLength(1)
  })

  it('[US-LAUNCH-006.AC13] a failure is delivered as the same launch.failed frame to every ui connection whatever its mode', async () => {
    const h = host({ starter: 'fake' })
    const panel = h.attach('ui')
    const veta = h.attach('ui')
    const valle = h.attach('ui')
    const notifier = h.attach('notifier')
    h.fake.arrange({ kind: 'rejects', cause: 'exited-at-once', toolOutputTail: 'Error: boom' })
    const launchId = await launched(h)
    await h.run(SETTLE_MS)
    const sent = [panel, veta, valle].map((ui) => frames(ui.sent, 'launch.failed'))
    expect(sent[0]).toEqual([
      {
        launchId,
        mineId: MINE,
        failure: {
          cause: 'exited-at-once',
          supplierLabel: 'Simulated',
          actions: ['retry'],
          toolOutputTail: 'Error: boom'
        }
      }
    ])
    expect(sent[1]).toEqual(sent[0])
    expect(sent[2]).toEqual(sent[0])
    expect(frames(notifier.sent, 'launch.failed')).toEqual([])
    expect(h.db.launches.seenAt(launchId)).not.toBeNull()
    expect(h.launchesSection()).toMatchObject([{ launchId, state: 'failed' }])
  })

  it('[US-LAUNCH-006.AC19, INV-55] exited-at-once and could-not-start carry the captured output tail of at most 400 characters, never in a DB row or the log', async () => {
    const h = host({ starter: 'fake' })
    const ui = h.attach()
    const tail = `${'early line '.repeat(30)}${'Z'.repeat(400)}`
    h.fake.arrange({ kind: 'rejects', cause: 'exited-at-once', toolOutputTail: tail })
    h.fake.arrange({ kind: 'rejects', cause: 'could-not-start', toolOutputTail: tail })
    const exited = await launched(h)
    await h.run(SETTLE_MS)
    const refused = await launched(h)
    await h.run(SETTLE_MS)

    const failures = frames(ui.sent, 'launch.failed') as Array<{
      launchId: LaunchId
      failure: { cause: string; toolOutputTail?: string }
    }>
    expect(failures.map((f) => [f.launchId, f.failure.cause, f.failure.toolOutputTail])).toEqual([
      [exited, 'exited-at-once', 'Z'.repeat(400)],
      [refused, 'could-not-start', 'Z'.repeat(400)]
    ])
    expect(h.launchesSection()).toMatchObject([
      { launchId: exited, failure: { toolOutputTail: 'Z'.repeat(400) } },
      { launchId: refused, failure: { toolOutputTail: 'Z'.repeat(400) } }
    ])
    // Never in a DB row …
    expect(h.db.launches.byId(exited)?.failure?.toolOutputTail).toBeUndefined()
    expect(h.db.launches.byId(refused)?.failure?.toolOutputTail).toBeUndefined()
    // … and never in the log, while the failure itself is logged.
    expect(h.log.byEvent('launch.failed')).toHaveLength(2)
    const logged = JSON.stringify([...h.log.entries, ...h.log.refused])
    expect(logged).not.toContain('ZZZZ')
    expect(logged).not.toContain('early line')
  })

  it('[US-LAUNCH-006.AC20] other causes and a launch with nothing captured carry no tail', async () => {
    const h = host({ starter: 'fake' })
    const ui = h.attach()
    h.fake.arrange({ kind: 'not-installed' })
    h.fake.arrange({ kind: 'rejects', cause: 'could-not-start' })
    await launched(h)
    await h.run(SETTLE_MS)
    await launched(h)
    await h.run(SETTLE_MS)
    const failures = frames(ui.sent, 'launch.failed') as Array<{ failure: object }>
    expect(failures.map((f) => f.failure)).toEqual([
      { cause: 'not-installed', supplierLabel: 'Simulated', actions: ['retry'] },
      { cause: 'could-not-start', supplierLabel: 'Simulated', actions: ['retry'] }
    ])
  })

  it('[US-RES-003.AC06, FM-135] a launch that failed while no UI was attached appears in no snapshot and no frame later', async () => {
    const h = host({ starter: 'fake' })
    const window = h.attach()
    h.fake.arrange({ kind: 'rejects', cause: 'exited-at-once', toolOutputTail: 'Error: boom' })
    const launchId = await launched(h)
    const lastSeq = window.sent.at(-1)?.seq ?? 0
    h.connections.detach(window.attached)
    await h.run(SETTLE_MS)
    expect(h.db.launches.byId(launchId)?.state).toBe('failed')

    // The window comes back and resumes its subscription: nothing about the failure is replayed.
    const back = h.attach('ui', window.attached.clientId)
    const resumed = h.connections.subscribe(
      back.attached.clientId,
      { resume: { epoch: EPOCH, lastSeq } },
      EPOCH
    )
    resumed.release()
    const fresh = h.attach('ui')
    expect(frames(back.sent, 'launch.failed')).toEqual([])
    expect(frames(fresh.sent, 'launch.failed')).toEqual([])
    expect(h.launchesSection()).toEqual([])
    expect(h.db.launches.seenAt(launchId)).toBeNull()
  })
})
