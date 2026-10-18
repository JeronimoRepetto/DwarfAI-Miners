// layer: L2
// L2 flow F3 for "Other…" (17 §1.2; 11 F3; UC-010; ISSUE-165): the person's own command sent in
// through the Host, composed as wiring/routes/launching.ts composes it — the launching module over
// its in-memory stores, the `SessionStarter` bridge over the suppliers module's registry with the
// real `HostedCommandDriver` (15 §4.11) spawning through the conformance harness's recording spawn
// (a fixture transport: no real process), crew and conversation over their in-memory doubles, the
// launch routes and frames, and B-M34 on the seam-B dispatcher. The SimulatedDriver is attached
// too, so an "Other…" dwarf is compared with a supplier dwarf of the same Host (BR-08). FakeClock,
// FakeScheduler and a RecordingEventBus: no real time, no process, no disk.
//
// TC-165-02 (a refused command fails could-not-start with nothing spawned), TC-165-03 (an "Other…"
// dwarf is indistinguishable from a supplier dwarf except for its launch record).
import { describe, expect, it } from 'vitest'
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
  ProviderId
} from '../../kernel/domain/values'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { inMemoryConversation } from '../../modules/conversation/testing/inMemoryConversation'
import { inMemoryCrew } from '../../modules/crew/testing/inMemoryCrew'
import { createLaunching, LaunchRefusedError, type LaunchingEvent } from '../../modules/launching'
import { inMemoryLaunching } from '../../modules/launching/testing/inMemoryLaunching'
import type { MineView } from '../../modules/mines'
import { createSuppliers, HOSTED_COMMAND_PROVIDER_ID } from '../../modules/suppliers'
import { RecordingSpawn, type SpawnScript } from '../../modules/suppliers/testing/recordingSpawn'
import { ConnectionRegistry, type AttachedConnection } from '../../transport/connectionRegistry'
import { Dispatcher } from '../../transport/dispatcher'
import { registerLaunchingLaunchCustom } from '../../transport/methods/launchingLaunchCustom'
import { createSessionStarter } from '../bridges/sessionStarter'
import { routeLaunching } from '../routes/launching'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-165' as HostEpoch
const MINE = '00000000-0000-7000-8000-0000000165a1' as MineId
const FOLDER = '/work/north-seam' as FolderPath
const SIMULATED = 'simulated' as ProviderId
const PROMPT = 'Survey the north seam and mark the face'
const COMMAND = '/opt/agents/my-agent --non-interactive --title "two words"'
const ARGV = ['/opt/agents/my-agent', '--non-interactive', '--title', 'two words']
/** Past the 3 s early window and the simulated handshake, with a margin. */
const SETTLE_MS = 3_200

const MINE_VIEW: MineView = {
  id: MINE,
  path: FOLDER as unknown as MineView['path'],
  name: 'north-seam' as MineView['name'],
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

/** One Host whose "Other…" spawns are decided by `spawn` (default: a program that keeps running). */
function host(spawn: () => SpawnScript = () => ({ kind: 'exit', afterMs: 60_000, code: 0 })) {
  const db = inMemoryLaunching(T0)
  const clock = db.clock
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const bus = new RecordingEventBus<LaunchingEvent>()
  const crew = inMemoryCrew()
  const conversation = inMemoryConversation()
  const processes = new RecordingSpawn({ clock, scheduler, decide: spawn })
  const suppliers = createSuppliers({
    catalogIds: CATALOG_PROVIDER_IDS as unknown as ProviderId[],
    publicBuild: false,
    clock,
    scheduler,
    simulatedSeed: 'seed-165',
    sink: { deliver: () => undefined },
    installResolver: { resolve: async () => null },
    fs: new FakeFs(),
    capabilityRecords: { record: () => undefined, latest: () => null },
    integrationGate: { state: () => 'off' },
    bus: { publish: () => undefined },
    ids,
    hostEpoch: EPOCH,
    hostedCommand: {
      processControl: processes,
      loginEnv: { PATH: '/usr/bin', HOME: '/home/j' },
      platform: 'linux',
      redact: (text) => text
    }
  })
  const launching = createLaunching({
    launches: db.launches,
    processes: db.processes,
    records: db.records,
    transactions: { inTransaction: (work) => db.inTransaction(work) },
    starter: createSessionStarter({
      launchDriver: suppliers.launchDriver,
      sessions: suppliers.sessions,
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
    installId: '00000000-0000-7000-8000-0000000165ff',
    log
  })
  const connections = new ConnectionRegistry({ validateFrame })
  routeLaunching({
    events: bus,
    launching,
    conversation: conversation.commands,
    frames: connections
  })
  const dispatcher = new Dispatcher({ log, clock, scheduler, state: () => 'ready' })
  registerLaunchingLaunchCustom(dispatcher, { launching: launching.commands })
  const sent: Sent[] = []
  const ui: AttachedConnection = {
    role: 'ui',
    clientId: 'c-ui-165',
    send<F extends HostFrameName>(name: F, data: HostFrameData[F]): void {
      sent.push({ name, data })
    },
    end: async () => undefined
  }
  connections.attach(ui)

  return {
    db,
    bus,
    log,
    crew,
    conversation,
    suppliers,
    launching,
    dispatcher,
    processes,
    sent,
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

async function sendOther(h: Host, command = COMMAND): Promise<LaunchId> {
  const res = await h.dispatcher.dispatch(
    {
      id: '1',
      method: 'launching.launchCustom',
      params: {
        mineId: MINE,
        command,
        prompt: PROMPT,
        requestId: '01890a5d-ac96-774b-bcce-b30209a81651'
      }
    },
    { role: 'ui', clientId: 'c-ui-165' }
  )
  if (!('result' in res)) throw new Error(`launchCustom was not accepted: ${JSON.stringify(res)}`)
  return (res.result as { launchId: LaunchId }).launchId
}

function failedFrames(h: Host): unknown[] {
  return h.sent.filter((frame) => frame.name === 'launch.failed').map((frame) => frame.data)
}

describe('launch Other… (F3)', () => {
  it('[US-OBS-007.AC05, S5.21] a valid custom command launches and its dwarf appears in the mine like any other dwarf', async () => {
    const h = host()
    const launchId = await sendOther(h)
    await h.run(SETTLE_MS)

    const [event] = h.bus.ofType('DwarfLaunched')
    expect(event?.payload).toMatchObject({
      launchId,
      mineId: MINE,
      delegated: false,
      prompt: PROMPT
    })
    const dwarfId = event?.payload.dwarfId
    expect(h.crew.queries.crewOf(MINE).map((d) => [d.id, d.status])).toEqual([[dwarfId, 'working']])
    // The argv as an array, never through a shell; the prompt on stdin, never in argv (18 C-17).
    expect(h.processes.spawns.map((spawn) => [spawn.executable, ...spawn.args])).toEqual([ARGV])
    expect(h.db.launches.byId(launchId)).toMatchObject({
      state: 'succeeded',
      dwarfId,
      request: { way: { kind: 'custom', command: { raw: COMMAND, argv: ARGV } } }
    })
    expect(h.db.records.live()).toMatchObject([
      { dwarfId, launchId, launchOptions: { providerId: HOSTED_COMMAND_PROVIDER_ID } }
    ])
    expect(h.log.byEvent('uncaught')).toEqual([])
  })

  it('[US-OBS-007.AC05, S5.17] a refused command fails could-not-start with the parser sentence as detail and nothing spawned', async () => {
    const h = host()
    const launchId = await sendOther(h, 'my-agent | tee log.txt')
    await h.run(SETTLE_MS)

    expect(h.processes.spawns).toEqual([])
    const [failed] = h.bus.ofType('LaunchFailed')
    expect(failed?.payload).toEqual({
      launchId,
      mineId: MINE,
      failure: { cause: 'could-not-start', supplierLabel: 'The custom command', actions: ['retry'] }
    })
    expect(failedFrames(h)).toHaveLength(1)
    // The parser's sentence (the metacharacter refusal) is diagnostic detail only: the record's
    // fixed `msg`, never notice copy.
    expect(h.log.byEvent('launch.failed')).toMatchObject([
      { causeClass: 'could-not-start', launchId, msg: expect.stringContaining('with no shell') }
    ])
    expect(h.db.launches.byId(launchId)).toMatchObject({
      state: 'failed',
      request: { way: { kind: 'custom', command: { raw: 'my-agent | tee log.txt', argv: [] } } }
    })
    expect(h.crew.queries.crewOf(MINE)).toEqual([])
  })

  it('[US-OBS-007.AC05, S5.16] a command whose program is not found fails not-installed', async () => {
    const h = host(() => ({ kind: 'fail', code: 'ENOENT' }))
    const launchId = await sendOther(h, 'no-such-agent --once')
    await h.run(SETTLE_MS)

    expect(h.bus.ofType('LaunchFailed').map((e) => e.payload)).toEqual([
      {
        launchId,
        mineId: MINE,
        failure: { cause: 'not-installed', supplierLabel: 'The custom command', actions: ['retry'] }
      }
    ])
    expect(h.db.launches.byId(launchId)?.state).toBe('failed')
    expect(h.crew.queries.crewOf(MINE)).toEqual([])
  })

  it('[US-OBS-007.AC04, US-LAUNCH-002.AC08, BR-08] a dwarf launched through Other is the same dwarf shape, rank, roster entry and chat as a supplier dwarf, and nothing records how it was created beyond the launch record', async () => {
    const h = host()
    const otherLaunch = await sendOther(h)
    const { launchId: supplierLaunch } = await h.launching.commands.launch({
      mineId: MINE,
      way: { kind: 'supplier', providerId: SIMULATED },
      prompt: PROMPT,
      jevOn: false,
      jevAutoAccept: false
    })
    await h.run(SETTLE_MS)

    const launched = h.bus.ofType('DwarfLaunched').map((e) => e.payload)
    expect(launched).toHaveLength(2)
    const dwarfOf = (launchId: LaunchId): DwarfId => {
      const found = launched.find((payload) => payload.launchId === launchId)
      if (found === undefined) throw new Error(`no dwarf for ${launchId}`)
      return found.dwarfId
    }
    const other = dwarfOf(otherLaunch)
    const supplier = dwarfOf(supplierLaunch)
    const roster = h.crew.queries.crewOf(MINE)
    const view = (id: DwarfId) => roster.find((dwarf) => dwarf.id === id)
    const shape = (id: DwarfId) => {
      const dwarf = view(id)
      if (dwarf === undefined) throw new Error(`no dwarf ${id}`)
      return {
        keys: Object.keys(dwarf).sort(),
        rank: dwarf.rank,
        status: dwarf.status,
        departed: dwarf.departed,
        mineId: dwarf.mineId
      }
    }
    // Same roster entry: the same fields, rank, status and mine.
    expect(shape(other)).toEqual(shape(supplier))
    // Same chat: the person's prompt is each dwarf's first message.
    const firstMessages = h.conversation.bus
      .ofType('MessagesAppended')
      .map((e) => [e.payload.dwarfId, e.payload.messages[0]?.text])
    expect(firstMessages).toEqual(
      expect.arrayContaining([
        [other, PROMPT],
        [supplier, PROMPT]
      ])
    )
    // The launch record is the one place that tells them apart: its provider and its ref.
    const records = h.db.records.live()
    const strip = (dwarfId: DwarfId) => {
      const record = records.find((r) => r.dwarfId === dwarfId)
      if (record === undefined) throw new Error(`no record for ${dwarfId}`)
      return Object.keys(record).sort()
    }
    expect(strip(other)).toEqual(strip(supplier))
    expect(records.find((r) => r.dwarfId === other)?.launchOptions.providerId).toBe(
      HOSTED_COMMAND_PROVIDER_ID
    )
  })

  it('[INV-43] Other is never a Jev candidate and never a default provider', async () => {
    const h = host()
    const launchable = await h.suppliers.catalogue.launchable()

    // Jev chooses among the launchable entries, and a Default provider is one of them: never Other.
    expect(launchable.map((entry) => entry.providerId)).not.toContain(HOSTED_COMMAND_PROVIDER_ID)
    expect(h.suppliers.catalogue.entry(HOSTED_COMMAND_PROVIDER_ID)).toBeNull()
    // Nor can it be sent in as a supplier chip: the supplier path refuses it before any row.
    await expect(
      h.launching.commands.launch({
        mineId: MINE,
        way: { kind: 'supplier', providerId: HOSTED_COMMAND_PROVIDER_ID },
        prompt: PROMPT,
        jevOn: false,
        jevAutoAccept: false
      })
    ).rejects.toEqual(new LaunchRefusedError('unknown-supplier'))
    expect(h.db.launches.inFlight()).toEqual([])
    expect(h.bus.ofType('LaunchRequested')).toEqual([])
  })
})
