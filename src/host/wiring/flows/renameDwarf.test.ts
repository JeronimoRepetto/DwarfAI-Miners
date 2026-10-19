// layer: L2
// L2 flow (17 §1.2): rename and reset name (UC-034; 16 §4.2 `CrewCommands.rename` / `resetName`;
// 14 §2.3 B-M22, B-M23; AMENDMENT-2, SC-AR-05) through the Host as host/main.ts wires it: the crew
// wiring (host/wiring/routes/crew.ts) serving B-M22 and B-M23 before the boot binds the endpoint and
// constructing the module over the Host database at boot step 4, mines beside it. The real boot step
// list, the Host dispatcher and connection registry behind in-process duplexes, one copy of the
// template database, a FakeClock, FakeScheduler and FakeProcessControl; observation's events are faked
// on the bus, as crew.flow.test.ts does. The harness below is that file's.
//
// TC-172-01 (through the Host), TC-172-02. No turn sender, relay or Jev router is constructed by the
// Host yet (later: EPIC-10, EPIC-12): what this flow records of the provider side is every row the
// Host stores, the process control, observation's ended-identity record and the diagnostics log.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  HOST_FRAME_SCHEMAS,
  HOST_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  evtFrameSchema,
  resFrameSchema,
  type FolderPath
} from '@dwarfai/contracts'
import type { ProcessIdentity } from '../../kernel/domain/processIdentity'
import type {
  DwarfId,
  EventId,
  HostEpoch,
  Instant,
  MineId,
  ProviderIdentity
} from '../../kernel/domain/values'
import { FakeAppPaths } from '../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { FsSourceWeightScanner } from '../../modules/mines/adapters/FsSourceWeightScanner'
import { createSqliteObservationStores } from '../../modules/observation'
import { NodeFs } from '../../platform/fs/NodeFs'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { HelloThrottle } from '../../transport/auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../../transport/auth/uiToken'
import { collectCapabilities } from '../../transport/capabilities'
import { acceptConnection } from '../../transport/connection'
import { ConnectionRegistry } from '../../transport/connectionRegistry'
import { BOARD_FRAMES } from '../../transport/frames/board'
import { createUpgradeDrain } from '../../transport/lifecycle/drain'
import { HostStateHolder } from '../../transport/lifecycle/hostState'
import { SILENCE_MS } from '../../transport/liveness'
import { createUpgradeTargetRule } from '../../transport/methods/hostUpgradeRequest'
import { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { FrameClient } from '../../transport/testing/frameClient'
import { inProcessDuplex } from '../../transport/testing/inProcessDuplex'
import { runBoot, type BootOutcome } from '../boot'
import { createBootSteps, mintBootEpoch } from '../bootSteps'
import { emptyDrainGate } from '../emptyDrainGate'
import { createHostDispatcher } from '../hostDispatcher'
import { serveCrew, type CrewRouteEvent, type WiredCrew } from '../routes/crew'
import {
  DEFAULT_MINES_SETTINGS,
  serveMines,
  type MinesRouteEvent,
  type WiredMines
} from '../routes/mines'

const T0 = 1_790_000_000_000
const HOUR_MS = 3_600_000
const BOOT_ID = 'boot-one'

const uuid = (n: number): string => `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

interface HostOptions {
  /** Another database: a restarted Host over the same file. */
  db?: SqliteDatabase
  /** The folder the mine folders go in (a restarted Host keeps its predecessor's). */
  root?: string
  /** The instant the Host boots at. */
  startAt?: Instant
}

/**
 * One Host start: the real boot step list, with step 4 wiring crew then mines over the database as
 * host/main.ts does and `startModules` starting mines' background work, and one `ui` client.
 */
async function bootHost(options: HostOptions = {}) {
  const root =
    options.root ?? realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-172-rename-')))
  if (options.root === undefined)
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const clock = new FakeClock(options.startAt ?? T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const processControl = new FakeProcessControl({ bootId: BOOT_ID, clock })
  processControl.scriptBootIdentity({ bootTimeMs: T0 - HOUR_MS, logonSessionId: 'logon-one' })
  const epoch = mintBootEpoch(ids)
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  const sections = new SectionRegistry()
  const lifecycle = { closeCleanly: () => Promise.resolve() }
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => state.current().state,
    stopAll: new RecordingStopAll(),
    lifecycle,
    connections,
    epoch,
    ids,
    sections,
    snapshotMeta: {
      hostVersion: () => '0.0.0-test',
      state: () => state.current().state,
      resetEpoch: () => 0,
      snapshotTail: () => 20,
      minesEverKnown: () => false
    },
    drain: createUpgradeDrain({ gate: emptyDrainGate, state, scheduler, lifecycle, log }),
    upgradeTarget: createUpgradeTargetRule({
      platform: 'linux',
      root: null,
      realpath: () => {
        throw new Error('no copy root in this case')
      }
    })
  })
  // What host/main.ts does before the boot: the members are served before the modules exist.
  const servedMines = serveMines({ dispatcher, sections, connections })
  const servedCrew = serveCrew({ dispatcher, sections })

  const db = options.db ?? openTemplateCopy().db
  const transactions = new SqliteTransactionRunner(db)
  const bus = new InProcessEventBus<MinesRouteEvent | CrewRouteEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => {
      throw failure.error
    }
  })
  /** Observation's process-identity read, scripted per dwarf (the real module: ISSUE-095). */
  const processIdentities = new Map<DwarfId, ProcessIdentity>()
  const endedRecorded: ProviderIdentity[] = []

  const host: { crew?: WiredCrew; mines?: WiredMines } = {}
  const boot: Promise<BootOutcome> = runBoot(
    (paths) =>
      createBootSteps({
        paths,
        clock,
        scheduler,
        ids,
        fs: new FakeFs(),
        processControl,
        log,
        endpoint: { bind: () => Promise.resolve('bound'), close: () => Promise.resolve() },
        database: { open: () => Promise.resolve() },
        // What host/main.ts does at step 4, with this machine's adapters.
        constructModules: () => {
          const crew = servedCrew.wire({
            db,
            transactions,
            lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
            bus,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch as HostEpoch,
            log,
            links: { owned: () => false, hasDeliveryRoute: () => false },
            processes: processControl,
            observation: {
              processIdentities: {
                processIdentityOf: (dwarfId) => processIdentities.get(dwarfId) ?? null
              },
              control: { recordEnded: (identity) => void endedRecorded.push({ ...identity }) },
              sessions: createSqliteObservationStores({ db, scope: transactions, clock }).sessions
            }
          })
          const mines = servedMines.wire({
            db,
            transactions,
            bus,
            clock,
            scheduler,
            ids,
            fs: new NodeFs(),
            hostEpoch: epoch as HostEpoch,
            log,
            mapSites: [],
            random: () => 0,
            scanner: new FsSourceWeightScanner(),
            ...DEFAULT_MINES_SETTINGS,
            crew: crew.mines
          })
          crew.route({ commands: mines.mines.commands, queries: mines.mines.queries })
          host.crew = crew
          host.mines = mines
        },
        startModules: () => host.mines?.start()
      }),
    {
      log,
      clock,
      state,
      privilege: () =>
        Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
      paths: { ok: true, value: new FakeAppPaths({ userDataDir: root }) },
      runtime: { os: 'win32', arch: 'x64', node: '24.18.1' },
      exit: () => undefined
    }
  )
  let outcome: BootOutcome | undefined
  void boot.then((settled) => (outcome = settled))
  for (let i = 0; i < 200 && outcome === undefined; i += 1) await tick()
  expect(state.current().state).toBe('ready')
  const { crew, mines } = host
  if (crew === undefined || mines === undefined) throw new Error('boot step 4 wired no crew')

  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const pair = inProcessDuplex()
  acceptConnection(pair.host, {
    token,
    ids,
    identity: { hostVersion: '0.0.0-test', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
    epoch,
    state: () => state.current(),
    capabilities: () =>
      collectCapabilities({
        methods: dispatcher.methods(),
        frames: BOARD_FRAMES,
        sections: sections.names()
      }),
    scheduler,
    clock,
    log,
    dispatcher,
    connections,
    throttle: new HelloThrottle(clock)
  })
  const ui = new FrameClient(pair.client)
  cleanups.push(() => void pair.client.destroy())
  ui.send({
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: PROTOCOL_VERSION,
    role: 'ui',
    token: secret,
    client: { appVersion: '0.0.0-test', buildId: 'abc1234', pid: 4242 }
  })
  await ui.settle()
  expect(ui.frames[0]).toMatchObject({ type: 'hello.ok' })

  /** A real folder holding one source file. */
  const folder = (name: string): FolderPath => {
    const path = join(root, name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'main.ts'), 'x'.repeat(2_048))
    return path as FolderPath
  }
  /** Every route, walk and check the Host started has answered. */
  const settle = async () => {
    await crew.idle()
    await mines.idle()
    await ui.settle()
  }
  /** The `ui` client's answer to `method`, validated by the contract. */
  const call = async (method: string, params: unknown) => {
    nextId += 1
    const id = `req-${nextId}`
    ui.send({ type: 'req', id, method, params })
    await ui.until(() => ui.frames.some((frame) => isRes(frame, id)))
    return resFrameSchema.parse(ui.frames.find((frame) => isRes(frame, id)))
  }
  /**
   * `ms` of Host time with the attached window alive: it pings within every `SILENCE_MS`, as the
   * UI's liveness does, so the Host does not detach it as silent (ADR-003 item 9).
   */
  const elapse = async (ms: number) => {
    for (let left = ms; left > 0; left -= SILENCE_MS / 2) {
      await call('ping', {})
      clock.advance(Math.min(left, SILENCE_MS / 2))
      await settle()
    }
  }
  /** A mine declared through `mines.declare`, measured and on the board. */
  const declare = async (path: FolderPath): Promise<MineId> => {
    const res = await call('mines.declare', { path, requestId: uuid(++nextRequest) })
    if (!res.ok) throw new Error(`mines.declare failed: ${res.error.code}`)
    const result = HOST_METHOD_SCHEMAS['mines.declare'].result.parse(res.result)
    if (!result.ok || !('mineId' in result.value)) throw new Error('no mine declared')
    await settle()
    return result.value.mineId as MineId
  }
  /** Observation's events, faked on the Host bus. */
  const envelope = () => ({
    v: 1 as const,
    id: ids.uuidv7() as EventId,
    at: clock.now(),
    hostEpoch: epoch as HostEpoch
  })
  const observed = async (
    identity: ProviderIdentity,
    cwd: FolderPath,
    extra: { firstMessage?: boolean; parentIdentity?: ProviderIdentity } = {}
  ) => {
    bus.publish({
      type: 'SessionObserved',
      ...envelope(),
      payload: { identity, cwd, streamId: `stream-${identity.providerSessionId}`, ...extra }
    })
    await settle()
  }
  const closed = async (identity: ProviderIdentity) => {
    bus.publish({
      type: 'SessionClosedObserved',
      ...envelope(),
      payload: { identity, at: clock.now() }
    })
    await settle()
  }
  /** A session observed already ended: its arrival and its ending in one batch (owner decision B). */
  const observedEnded = async (
    identity: ProviderIdentity,
    cwd: FolderPath,
    extra: { firstMessage?: boolean } = {}
  ) => {
    bus.publish({
      type: 'SessionObserved',
      ...envelope(),
      payload: { identity, cwd, streamId: `stream-${identity.providerSessionId}`, ...extra }
    })
    bus.publish({
      type: 'SessionClosedObserved',
      ...envelope(),
      payload: { identity, at: clock.now() }
    })
    await settle()
  }
  /** The dwarf bound to `identity` in the Host database, if any. */
  const dwarfOf = (identity: ProviderIdentity): DwarfId | null =>
    (db.all(`SELECT id FROM dwarfs WHERE provider_id = ? AND provider_session_id = ?`, [
      identity.providerId,
      identity.providerSessionId
    ])[0]?.['id'] as DwarfId | undefined) ?? null
  /** The board frames the `ui` client received, by name. */
  const evts = (name: string) =>
    ui.frames.flatMap((frame) => {
      if ((frame as { type?: string }).type !== 'evt') return []
      const evt = evtFrameSchema.parse(frame)
      return evt.name === name ? [evt.data] : []
    })
  return {
    root,
    clock,
    scheduler,
    db,
    bus,
    crew,
    mines,
    ui,
    sections,
    processControl,
    processIdentities,
    endedRecorded,
    log,
    folder,
    settle,
    call,
    elapse,
    declare,
    observed,
    observedEnded,
    closed,
    dwarfOf,
    evts
  }
}

let nextId = 0
let nextRequest = 0

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id?: string }).id === id
  )
}

/** Lets pending promise chains run (no timer). */
async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

const session = (id: string): ProviderIdentity => ({
  providerId: 'simulated',
  providerSessionId: id
})

type Host = Awaited<ReturnType<typeof bootHost>>

/** `crew.rename` over the wire, its validated result. */
async function rename(h: Host, dwarfId: DwarfId, name: string) {
  const res = await h.call('crew.rename', { dwarfId, name, requestId: uuid(++nextRequest) })
  if (!res.ok) throw new Error(`crew.rename refused: ${res.error.code}`)
  await h.settle()
  return HOST_METHOD_SCHEMAS['crew.rename'].result.parse(res.result)
}

/** `crew.resetName` over the wire. */
async function resetName(h: Host, dwarfId: DwarfId) {
  const res = await h.call('crew.resetName', { dwarfId, requestId: uuid(++nextRequest) })
  if (!res.ok) throw new Error(`crew.resetName refused: ${res.error.code}`)
  await h.settle()
  return HOST_METHOD_SCHEMAS['crew.resetName'].result.parse(res.result)
}

/** The `dwarfs` section of a fresh snapshot: what a window reads when it attaches. */
async function dwarfsOnTheBoard(h: Host) {
  const res = await h.call('session.snapshot', {})
  if (!res.ok) throw new Error(`session.snapshot refused: ${res.error.code}`)
  const page = HOST_METHOD_SCHEMAS['session.snapshot'].result.parse(res.result)
  return page.chunks.flatMap((chunk) => (chunk.section === 'dwarfs' ? chunk.data : []))
}

/** Every text value the Host database stores, as `table.column`, for the custom-name search. */
function storedTexts(db: SqliteDatabase): Array<{ at: string; text: string }> {
  const tables = db
    .all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .map((row) => String(row['name']))
  return tables.flatMap((table) =>
    db
      .all(`SELECT * FROM "${table}"`)
      .flatMap((row) =>
        Object.entries(row).flatMap(([column, value]) =>
          typeof value === 'string' ? [{ at: `${table}.${column}`, text: value }] : []
        )
      )
  )
}

/** The dwarf of a subagent `identity` (its own UNIQUE key includes the agent id, INV-21). */
function subagentOf(h: Host, mineId: MineId, identity: ProviderIdentity): DwarfId {
  const dwarf = h.crew.crew.queries
    .crewOf(mineId, { includeDeparted: true })
    .find((d) => d.identity.providerAgentId === identity.providerAgentId)
  if (dwarf === undefined) throw new Error('no subagent arrived')
  return dwarf.id
}

/** A present foreman in a declared mine; its id and base name. */
async function foreman(h: Host, folder = 'north-seam', id = 's-north') {
  const mineId = await h.declare(h.folder(folder))
  await h.observed(session(id), h.folder(folder))
  const dwarfId = h.dwarfOf(session(id))
  if (dwarfId === null) throw new Error('no dwarf arrived')
  const baseName = h.crew.crew.queries.get(dwarfId)?.baseName ?? ''
  return { mineId, dwarfId, baseName }
}

describe('rename and reset name', () => {
  it("[US-MSG-005.AC02, US-MSG-005.AC06, BR-14] a saved name is stored and becomes the dwarf's display name everywhere", async () => {
    const h = await bootHost()
    const { mineId, dwarfId, baseName } = await foreman(h)

    expect(await rename(h, dwarfId, '  Watcher   of seals ')).toStrictEqual({
      ok: true,
      value: { customName: 'Watcher of seals' }
    })

    expect(h.db.all('SELECT custom_name, base_name FROM dwarfs WHERE id = ?', [dwarfId])).toEqual([
      { custom_name: 'Watcher of seals', base_name: baseName }
    ])
    // Every read that names the dwarf: the board, the crew view, the notification titles' name
    // (INV-104) and the mine history's speakers.
    const board = await dwarfsOnTheBoard(h)
    expect(board.map((d) => [d.id, d.customName])).toStrictEqual([[dwarfId, 'Watcher of seals']])
    expect(h.crew.crew.queries.get(dwarfId)?.displayName).toBe('Watcher of seals')
    expect(h.crew.crew.queries.displayName(dwarfId)).toBe('Watcher of seals')
    expect(
      h.crew.crew.queries.crewOf(mineId, { includeDeparted: true }).map((d) => d.displayName)
    ).toStrictEqual(['Watcher of seals'])
  })

  it('[US-MINE-001.AC03] the dwarf view carries both the custom name and the base name for the tooltip', async () => {
    const h = await bootHost()
    const { dwarfId, baseName } = await foreman(h)

    await rename(h, dwarfId, 'Gimli')

    const [wire] = await dwarfsOnTheBoard(h)
    expect(wire).toMatchObject({ id: dwarfId, customName: 'Gimli', baseName })
    expect(baseName).not.toBe('')
    expect(h.crew.crew.queries.get(dwarfId)).toMatchObject({
      customName: 'Gimli',
      baseName,
      displayName: 'Gimli'
    })
  })

  it('[US-MSG-005.AC09] two dwarfs may carry the same custom name', async () => {
    const h = await bootHost()
    const first = await foreman(h, 'north-seam', 's-north')
    const second = await foreman(h, 'south-seam', 's-south')

    expect(await rename(h, first.dwarfId, 'Gimli')).toMatchObject({ ok: true })
    expect(await rename(h, second.dwarfId, 'Gimli')).toStrictEqual({
      ok: true,
      value: { customName: 'Gimli' }
    })

    expect((await dwarfsOnTheBoard(h)).map((d) => d.customName)).toStrictEqual(['Gimli', 'Gimli'])
  })

  it('[US-MSG-005.AC11, NFR-PRIV-03] no turn input, relay text or Jev request carries the custom name', async () => {
    const h = await bootHost()
    const { mineId, dwarfId, baseName } = await foreman(h)
    const name = 'Keeper of Seals'

    await rename(h, dwarfId, name)
    await h.observed(
      { ...session('s-north'), providerAgentId: 'agent-1' },
      h.folder('north-seam'),
      { parentIdentity: session('s-north') }
    )
    await h.closed(session('s-north'))

    // The custom name is in one place only, the display column; the agent-facing base name, the
    // provider identity and every other stored row are untouched (NFR-PRIV-03).
    expect(
      storedTexts(h.db)
        .filter((entry) => entry.text.includes(name))
        .map((entry) => entry.at)
    ).toStrictEqual(['dwarfs.custom_name'])
    expect(h.crew.crew.queries.get(dwarfId)?.baseName).toBe(baseName)
    expect(JSON.stringify(h.endedRecorded)).not.toContain(name)
    expect(JSON.stringify(h.processControl)).not.toContain(name)
    // Never logged either (NFR-SEC-12).
    expect(JSON.stringify([h.log.entries, h.log.refused])).not.toContain(name)
    expect(h.crew.crew.queries.crewOf(mineId, { includeDeparted: true })).toHaveLength(2)
  })

  it('[US-MSG-005.AC12, NFR-PERS-09] a custom name survives a Host restart', async () => {
    const first = await bootHost()
    const { dwarfId } = await foreman(first)
    await rename(first, dwarfId, 'Watcher of seals')

    // The Host stops and a new one starts over the same database.
    const next = await bootHost({ db: first.db, root: first.root, startAt: T0 + HOUR_MS })

    expect(next.crew.crew.queries.get(dwarfId)?.displayName).toBe('Watcher of seals')
    expect((await dwarfsOnTheBoard(next)).map((d) => d.customName)).toStrictEqual([
      'Watcher of seals'
    ])
  })

  it("[US-MSG-005.AC13] a subagent's custom name stays on its past turns in the mine history after it departs", async () => {
    const h = await bootHost()
    const { mineId } = await foreman(h)
    const subagent = { ...session('s-north'), providerAgentId: 'agent-1' }
    await h.observed(subagent, h.folder('north-seam'), { parentIdentity: session('s-north') })
    const subagentId = subagentOf(h, mineId, subagent)
    await rename(h, subagentId, 'Scout')

    await h.closed(session('s-north'))

    // The mine history's speakers are crew's `crewOf(mineId, { includeDeparted: true })`
    // (conversation/application/queries.ts): the departed subagent is listed under its custom name.
    const speakers = h.crew.crew.queries.crewOf(mineId, { includeDeparted: true })
    expect(speakers.find((d) => d.id === subagentId)).toMatchObject({
      displayName: 'Scout',
      departed: true
    })
    // Going forward it is gone from the board.
    expect((await dwarfsOnTheBoard(h)).map((d) => d.id)).not.toContain(subagentId)
  })

  it('[US-MSG-005.AC14] a dwarf of any rank can be renamed', async () => {
    const h = await bootHost()
    const { mineId, dwarfId } = await foreman(h)
    const worker = { ...session('s-north'), providerAgentId: 'agent-1' }
    const worker2 = { ...session('s-north'), providerAgentId: 'agent-2' }
    await h.observed(worker, h.folder('north-seam'), { parentIdentity: session('s-north') })
    await h.observed(worker2, h.folder('north-seam'), { parentIdentity: worker })
    const ids = [dwarfId, subagentOf(h, mineId, worker), subagentOf(h, mineId, worker2)]

    for (const [i, id] of ids.entries()) await rename(h, id, `Dwarf ${i + 1}`)

    expect(h.crew.crew.queries.crewOf(mineId).map((d) => [d.rank, d.displayName])).toStrictEqual([
      ['foreman', 'Dwarf 1'],
      ['worker', 'Dwarf 2'],
      ['worker2', 'Dwarf 3']
    ])
  })

  it('[US-MSG-006.AC03] resetName clears the custom name at once and the base name shows everywhere', async () => {
    const h = await bootHost()
    const { mineId, dwarfId, baseName } = await foreman(h)
    await rename(h, dwarfId, 'Gimli')

    expect(await resetName(h, dwarfId)).toStrictEqual({})

    expect(h.db.all('SELECT custom_name FROM dwarfs WHERE id = ?', [dwarfId])).toEqual([
      { custom_name: null }
    ])
    expect((await dwarfsOnTheBoard(h)).map((d) => d.customName)).toStrictEqual([null])
    expect(h.crew.crew.queries.displayName(dwarfId)).toBe(baseName)
    expect(h.crew.crew.queries.crewOf(mineId).map((d) => d.displayName)).toStrictEqual([baseName])
  })
})
