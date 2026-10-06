// layer: L2
// L2 flow (17 §1.2): the crew module wired into the Host (05 §4; 16 §8.2, §8.3) through
// host/wiring/routes/crew.ts, as host/main.ts wires it: its `dwarfs` snapshot section and B-M41
// served before the boot binds the endpoint, the module, the `SessionTerminator` bridge and the one
// `SqliteLifecycleFactLog` constructed at boot step 4 before mines (which ends dwarfs through
// crew's ends), then the 05 §4 observation routes and the boot recompute of the statuses (S1.18)
// once mines exists. The real boot step list, the Host dispatcher and connection registry behind
// in-process duplexes, one copy of the template database, a FakeClock, FakeScheduler and
// FakeProcessControl. Observation's events are faked on the bus; its process-identity read and
// `recordEnded` are scripted here, as ISSUE-095 binds the real module. Mine folders are real temp
// folders, because mines resolves a cwd on the real disk.
//
// TC-094-01, TC-094-02, TC-094-03.
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
  frameCapability,
  methodCapability,
  resFrameSchema,
  sectionCapability,
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
import { ASLEEP_AFTER_MS } from '../../modules/crew'
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
  const root = options.root ?? realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-094-crew-')))
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

describe('the crew module wired into the Host (ISSUE-094)', () => {
  it('[S2.01, S1.02] a SessionObserved in a known mine makes a present idle dwarf and sends dwarf.arrived', async () => {
    const h = await bootHost()
    const mineId = await h.declare(h.folder('north-seam'))

    await h.observed(session('s-north'), h.folder('north-seam'))

    const dwarfId = h.dwarfOf(session('s-north'))
    expect(dwarfId).not.toBeNull()
    expect(h.crew.crew.queries.crewOf(mineId).map((d) => [d.id, d.status, d.rank])).toEqual([
      [dwarfId, 'idle', 'foreman']
    ])
    expect(h.evts('dwarf.arrived')).toEqual([
      expect.objectContaining({
        dwarf: expect.objectContaining({ id: dwarfId, mineId, status: 'idle' }),
        announce: true
      })
    ])
  })

  it('[INV-39] a SessionObserved in a never-seen folder with no message makes no mine and no dwarf', async () => {
    const h = await bootHost()

    await h.observed(session('s-quiet'), h.folder('quiet-drift'))

    expect(h.dwarfOf(session('s-quiet'))).toBeNull()
    expect(h.mines.mines.queries.list({ sortBy: 'name', direction: 'asc' })).toEqual([])
    expect(h.evts('dwarf.arrived')).toEqual([])
  })

  it('[S1.05] with the fake clock 60 s later the dwarf is asleep and dwarf.changed is sent', async () => {
    const h = await bootHost()
    await h.declare(h.folder('east-drift'))
    await h.observed(session('s-east'), h.folder('east-drift'))
    const dwarfId = h.dwarfOf(session('s-east'))

    await h.elapse(ASLEEP_AFTER_MS)

    expect(h.evts('dwarf.changed')).toEqual([
      { dwarf: expect.objectContaining({ id: dwarfId, status: 'asleep' }) }
    ])
  })

  it('[S2.06] a SessionClosedObserved departs the dwarf closed-elsewhere and sends dwarf.departed', async () => {
    const h = await bootHost()
    const mineId = await h.declare(h.folder('west-adit'))
    await h.observed(session('s-west'), h.folder('west-adit'))
    const dwarfId = h.dwarfOf(session('s-west'))

    await h.closed(session('s-west'))

    expect(h.crew.crew.queries.get(dwarfId as DwarfId)).toMatchObject({
      departed: true,
      departureCause: 'closed-elsewhere'
    })
    expect(h.evts('dwarf.departed')).toEqual([{ dwarfId, mineId, cause: 'closed-elsewhere' }])
  })

  it('[ADR-014] a mine removal ends its observed dwarfs through the wired terminator bridge', async () => {
    const h = await bootHost()
    const mineId = await h.declare(h.folder('deep-vein'))
    await h.observed(session('s-deep'), h.folder('deep-vein'))
    const dwarfId = h.dwarfOf(session('s-deep'))
    if (dwarfId === null) return expect.fail('the observed session made no dwarf')
    const process: ProcessIdentity = {
      pid: 4_210,
      processStartTimeMs: T0 - 60_000,
      bootId: BOOT_ID
    }
    h.processIdentities.set(dwarfId, process)
    h.processControl.scriptTree(process)

    const res = await h.call('mines.remove', { mineId, requestId: uuid(++nextRequest) })
    await h.settle()

    expect(res).toMatchObject({ ok: true, result: { ok: true, value: {} } })
    // The bridge ended the recorded tree by identity, never as a process group (ADR-014 item 3).
    expect(h.processControl.signals.filter((s) => s.scope === 'group')).toEqual([])
    expect(h.processControl.signals.map((s) => s.pid)).toContain(process.pid)
    expect(h.endedRecorded).toEqual([session('s-deep')])
    expect(h.evts('dwarf.departed')).toEqual([{ dwarfId, mineId, cause: 'mine-removed' }])
    expect(h.mines.mines.queries.get(mineId)).toBeNull()
  })

  it('[ADR-015] strangler.dwarfIdentities on the composed Host returns the present dwarfs', async () => {
    const h = await bootHost()
    await h.declare(h.folder('south-stope'))
    await h.observed(session('s-south'), h.folder('south-stope'))
    const dwarfId = h.dwarfOf(session('s-south'))

    const res = await h.call('strangler.dwarfIdentities', {})

    expect(res).toMatchObject({
      ok: true,
      result: [{ dwarfId, providerId: 'simulated', identity: session('s-south') }]
    })
  })

  it('[ADR-015] the composed Host advertises section:dwarfs, the dwarf frames and B-M41 in hello.ok and serves the present crew in the section', async () => {
    const h = await bootHost()
    const mineId = await h.declare(h.folder('high-gallery'))
    await h.observed(session('s-high'), h.folder('high-gallery'))
    const helloOk = h.ui.frames[0] as { capabilities: string[] }

    expect(helloOk.capabilities).toEqual(
      expect.arrayContaining([
        sectionCapability('dwarfs'),
        frameCapability('dwarf.arrived'),
        frameCapability('dwarf.changed'),
        frameCapability('dwarf.departed'),
        methodCapability('strangler.dwarfIdentities')
      ])
    )
    expect(h.sections.get('dwarfs')?.provider()).toEqual([
      expect.objectContaining({ id: h.dwarfOf(session('s-high')), mineId })
    ])
  })

  it('[S1.18] after a Host restart the statuses are recomputed from the persisted facts and an idle dwarf falls asleep on time', async () => {
    const first = await bootHost()
    await first.declare(first.folder('old-shaft'))
    await first.observed(session('s-old'), first.folder('old-shaft'))
    const dwarfId = first.dwarfOf(session('s-old'))

    // The Host stops and a new one starts over the same database, halfway to the asleep instant.
    const next = await bootHost({
      db: first.db,
      root: first.root,
      startAt: T0 + ASLEEP_AFTER_MS / 2
    })
    expect(next.crew.crew.statusTimer.statusOf(dwarfId as DwarfId)).toBe('idle')
    await next.elapse(ASLEEP_AFTER_MS / 2)

    expect(next.evts('dwarf.changed')).toEqual([
      { dwarf: expect.objectContaining({ id: dwarfId, status: 'asleep' }) }
    ])
  })
})
