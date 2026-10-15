// layer: L8
// L8 OS lane (17 §1.8; ADR-002 D1; PO #63; INV-122; UC-022, UC-024): an owned session belongs to
// the Host, so the app closing — every window's `ui` connection closed and the tray's `notifier`
// connection gone — ends nothing. Over this OS's real UI endpoint (the owner-only named pipe on
// Windows, the `0600` Unix socket elsewhere) and a real Host database file migrated by the Host's
// own runner, the Host side is composed as host/main.ts composes it: crew over SQLite, the
// suppliers module, and launching wired by wiring/routes/launching.ts with B-M33 on the real
// dispatcher. A UI launches over the socket, then every UI goes away while the launch is in flight.
//
// The session is the suppliers catalog's SimulatedDriver (15 §4.12): it is the one driver a
// development build attaches until the real drivers land (later: ISSUE-148…ISSUE-163), so no
// provider process exists here; the Host-side facts that make a session outlive the app (its
// launch settles, its dwarf stays present, its `launch_records` row keeps its resume intent, no
// end is requested) are asserted, and the kernel's process-tree kill is never reached. A `src/host`
// test cannot spawn the built Host itself (R10, R17); the built Host's served list is checked by
// the UI's own OS test (ui-main/host-client/hostClient.os.test.ts).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CATALOG_PROVIDER_IDS,
  checkSocketPathLength,
  HOST_FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  type HostEndpoint
} from '@dwarfai/contracts'
import type { DomainEvent } from './kernel/domain/domainEvent'
import type { HostEpoch, MineId, ProviderId } from './kernel/domain/values'
import { RecordingDiagnosticsLog } from './kernel/fakes/RecordingDiagnosticsLog'
import { FakeFs } from './kernel/fakes/FakeFs'
import { SequenceIdGenerator } from './kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from './kernel/InProcessEventBus'
import { createCrew, type CrewEndEvent, type CrewEvent } from './modules/crew'
import type { LaunchingEvent } from './modules/launching'
import { MINE, MINE_FOLDER, seedMine } from './modules/launching/testing/sqliteLaunchingDb'
import type { MineView } from './modules/mines'
import { createSuppliers } from './modules/suppliers'
import { NodeScheduler } from './platform/clock/NodeScheduler'
import { SystemClock } from './platform/clock/SystemClock'
import { createNativeOwnerOnlyPipe } from './platform/endpoint/win-pipe/nativeOwnerOnlyPipe'
import { NodeSqliteDatabase } from './platform/sqlite/NodeSqliteDatabase'
import { SqliteLifecycleFactLog } from './platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from './platform/sqlite/SqliteTransactionRunner'
import { buildTemplateDb } from './platform/sqlite/testing/templateDb.globalSetup'
import { HelloThrottle } from './transport/auth/throttle'
import { UI_TOKEN_FILE, UiToken } from './transport/auth/uiToken'
import { acceptConnection } from './transport/connection'
import { ConnectionRegistry } from './transport/connectionRegistry'
import { Dispatcher } from './transport/dispatcher'
import { bindEndpoint } from './transport/endpoint/server'
import { HostStateHolder } from './transport/lifecycle/hostState'
import { SectionRegistry } from './transport/snapshot/sectionRegistry'
import { FrameClient } from './transport/testing/frameClient'
import { decideBind } from './wiring/singleInstance'
import { serveLaunching } from './wiring/routes/launching'

const WINDOWS = process.platform === 'win32'
const EPOCH = 'epoch-162-os' as HostEpoch
const SIMULATED = 'simulated' as ProviderId
const PROMPT = 'Survey the north seam'
const CASE_TIMEOUT_MS = 60_000

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A fresh folder; on POSIX directly under /tmp so the socket path fits `sun_path` on macOS. */
function caseRoot(): string {
  const root = WINDOWS ? mkdtempSync(join(tmpdir(), 'dwarfai-162-os-')) : mkdtempSync('/tmp/dw162-')
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  )
  return root
}

function endpointUnder(root: string): HostEndpoint {
  if (WINDOWS) {
    const suffix = `${process.pid}-${Math.random().toString(16).slice(2, 10)}`
    return { kind: 'named-pipe', path: `\\\\.\\pipe\\dwarfai-test-162-${suffix}` }
  }
  const dir = join(root, 'run')
  const path = join(dir, 'host-0123456789ab.sock')
  const fits = checkSocketPathLength(process.platform === 'darwin' ? 'darwin' : 'linux', path)
  if (!fits.ok) throw new Error(`test socket path too long for this OS: ${JSON.stringify(fits)}`)
  return { kind: 'unix-socket', dir, path }
}

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, { parse(value: unknown): unknown } | undefined>> =
    HOST_FRAME_SCHEMAS
  schemas[name]?.parse(data)
}

/** Waits until `check` holds, polling every 25 ms, for at most `ms`. */
async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const ACTIVE_MINE: MineView = {
  id: MINE,
  path: MINE_FOLDER as unknown as MineView['path'],
  name: 'mine-one' as MineView['name'],
  state: 'active',
  tier: null,
  sourceWeight: null,
  hasBeenMeasured: false,
  createdAt: 0,
  lastUsedAt: 0,
  presentDwarfs: 0
}

// AMENDED for ISSUE-171: the launching wiring also routes crew's end events (routeStops).
type OsHostEvent = CrewEvent | CrewEndEvent | LaunchingEvent

/** The Host side over a real database file and the real endpoint, with launching served. */
async function realEndpointHost() {
  const root = caseRoot()
  const template = buildTemplateDb()
  cleanups.push(() => rmSync(template.dir, { recursive: true, force: true }))
  const db = NodeSqliteDatabase.open(template.path)
  cleanups.push(() => db.close())
  const transactions = new SqliteTransactionRunner(db)
  seedMine(db, transactions)

  const clock = new SystemClock()
  const scheduler = new NodeScheduler({ onTaskError: () => {} })
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const handlerErrors: unknown[] = []
  const bus = new InProcessEventBus<OsHostEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => handlerErrors.push(failure.error)
  })
  const published: DomainEvent<string, unknown>[] = []
  for (const type of ['DwarfArrived', 'DwarfDeparted', 'DwarfLaunched', 'LaunchFailed'] as const) {
    bus.subscribe(type, (event) => published.push(event))
  }
  const crew = createCrew({
    db,
    transactions,
    lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH,
    links: { owned: () => false, hasDeliveryRoute: () => false }
  })
  const suppliers = createSuppliers({
    catalogIds: CATALOG_PROVIDER_IDS as unknown as ProviderId[],
    publicBuild: false,
    clock,
    scheduler,
    simulatedSeed: 'seed-162-os',
    sink: { deliver: () => undefined },
    installResolver: { resolve: async () => null },
    fs: new FakeFs(),
    capabilityRecords: { record: () => undefined, latest: () => null },
    integrationGate: { state: () => 'off' },
    bus: { publish: () => undefined },
    ids,
    hostEpoch: EPOCH
  })

  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: WINDOWS ? 'none' : 'n/a' })
  const dispatcher = new Dispatcher({ log, clock, scheduler, state: () => state.current().state })
  const sections = new SectionRegistry()
  const launching = serveLaunching({ dispatcher, sections }).wire({
    db,
    transactions,
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH,
    installId: '00000000-0000-7000-8000-0000000162ff',
    log,
    frames: connections,
    suppliers,
    mines: {
      get: (id: MineId) => (id === MINE ? ACTIVE_MINE : null),
      folderOf: (id: MineId) => (id === MINE ? MINE_FOLDER : null)
    },
    crew: crew.commands,
    conversation: { ingest: () => undefined }
  })
  cleanups.push(() => launching.stop())

  const endpoint = endpointUnder(root)
  const runDir = join(root, 'run')
  const token = new UiToken()
  const outcome = await bindEndpoint(endpoint, {
    log,
    scheduler,
    decide: decideBind,
    probeExisting: () => Promise.resolve('no-hello'),
    ownerOnlyPipe: createNativeOwnerOnlyPipe({
      prebuildsDir: fileURLToPath(new URL('../../prebuilds', import.meta.url))
    }),
    accept: (connection) =>
      acceptConnection(connection, {
        token,
        ids,
        identity: { hostVersion: '0.20.0', buildId: 'os-162', protocolVersion: PROTOCOL_VERSION },
        epoch: EPOCH,
        state: () => state.current(),
        capabilities: () => [],
        scheduler,
        clock,
        log,
        dispatcher,
        connections,
        throttle: new HelloThrottle(clock)
      })
  })
  if (outcome.kind !== 'bound') throw new Error(`expected a bind, got ${outcome.kind}`)
  cleanups.push(() => outcome.endpoint.close())
  await token.issue(runDir)
  const secret = readFileSync(join(runDir, UI_TOKEN_FILE), 'utf8')

  /** Connects with `role` over the real endpoint and waits for hello.ok. */
  const attach = async (role: 'ui' | 'notifier'): Promise<FrameClient> => {
    const socket = connect(endpoint.path)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    cleanups.push(() => void socket.destroy())
    const client = new FrameClient(socket)
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: secret,
      client: { appVersion: '0.20.0', buildId: 'os-162', pid: 4242 }
    })
    await client.until(() => client.frames.length > 0, 10_000)
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }

  /** Every window and the tray go away: their connections close, and nothing is sent first. */
  const closeTheApp = async (clients: readonly FrameClient[]): Promise<void> => {
    for (const client of clients) client.stream.destroy()
    await until(() => connections.connections().length === 0)
  }

  const launchState = (): string | null => {
    const [row] = db.all('SELECT state FROM launches')
    return typeof row?.['state'] === 'string' ? row['state'] : null
  }

  return {
    db,
    crew,
    launching,
    published,
    handlerErrors,
    attach,
    closeTheApp,
    launchState
  }
}

/** Sends B-M33 on `ui` and waits for its answer. */
async function sendTheDwarfIn(ui: FrameClient): Promise<unknown> {
  ui.send({
    type: 'req',
    id: 'launch-1',
    method: 'launching.launch',
    params: {
      mineId: MINE,
      way: { kind: 'supplier', providerId: SIMULATED },
      prompt: PROMPT,
      jevOn: false,
      jevAutoAccept: false,
      requestId: '01890a5d-ac96-774b-bcce-b302099a8162'
    }
  })
  await ui.until(
    () => ui.frames.some((frame) => (frame as { type?: string }).type === 'res'),
    10_000
  )
  return ui.frames.find((frame) => (frame as { type?: string }).type === 'res')
}

describe.runIf(['win32', 'darwin', 'linux'].includes(process.platform))(
  'an owned session outlives the app (real endpoint)',
  () => {
    it(
      '[US-RES-002.AC01, FM-136] closing every window and quitting the tray ends no owned session',
      async () => {
        const host = await realEndpointHost()
        const window = await host.attach('ui')
        const otherWindow = await host.attach('ui')
        const tray = await host.attach('notifier')

        const res = await sendTheDwarfIn(window)
        expect(res).toMatchObject({
          type: 'res',
          ok: true,
          result: { launchId: expect.any(String) }
        })
        // The launch is in flight; the app closes entirely before its session has started.
        expect(host.launchState()).toMatch(/^(resolving|spawned)$/)
        await host.closeTheApp([window, otherWindow, tray])

        await until(() => host.launchState() === 'succeeded')
        const [dwarf] = host.crew.queries.crewOf(MINE)
        expect(dwarf).toMatchObject({ status: 'working', departed: false })
        expect(host.launching.launching.queries.ownedCount()).toBe(1)
        expect(host.db.all('SELECT resume_intent, ended_at FROM launch_records')).toEqual([
          { resume_intent: 1, ended_at: null }
        ])
        expect(host.published.map((event) => event.type)).not.toContain('DwarfDeparted')
        expect(host.handlerErrors).toEqual([])
      },
      CASE_TIMEOUT_MS
    )

    it(
      '[US-RES-002.AC02, INV-122, NFR-PERS-01] a launched dwarf keeps running after the app closes exactly like an observed one',
      async () => {
        const host = await realEndpointHost()
        const window = await host.attach('ui')
        const tray = await host.attach('notifier')
        await sendTheDwarfIn(window)
        await until(() => host.launchState() === 'succeeded')
        // An observed dwarf in the same mine: a session DwarfAI did not launch.
        const observed = host.crew.commands.arrive({
          mineId: MINE,
          identity: { providerId: SIMULATED, providerSessionId: 'observed-elsewhere' },
          rank: 'foreman',
          status: 'working'
        })
        const before = host.crew.queries.crewOf(MINE)

        await host.closeTheApp([window, tray])

        const after = host.crew.queries.crewOf(MINE)
        expect(after).toHaveLength(2)
        const launched = after.find((dwarf) => dwarf.id !== observed)
        const stillObserved = after.find((dwarf) => dwarf.id === observed)
        // Closing draws no distinction between the two origins: both are present, as before.
        for (const dwarf of [launched, stillObserved]) {
          expect(dwarf).toMatchObject({ departed: false, status: 'working' })
        }
        expect(after.map((dwarf) => [dwarf.id, dwarf.presence, dwarf.processState])).toEqual(
          before.map((dwarf) => [dwarf.id, dwarf.presence, dwarf.processState])
        )
        expect(host.launching.launching.queries.ownedCount()).toBe(1)
        expect(host.published.map((event) => event.type)).not.toContain('DwarfDeparted')
      },
      CASE_TIMEOUT_MS
    )
  }
)
