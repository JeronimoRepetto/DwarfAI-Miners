// layer: L2
// L2 flow (17 §1.2): the mines module wired into the Host (05 §4; 16 §8.2, §8.3) through
// host/wiring/routes/mines.ts, as host/main.ts wires it: its seam-B members (14 §2.3 B-M16…B-M20)
// and the `mines` snapshot section served before the boot binds the endpoint, the module and its
// scoring walks constructed at boot step 4, the 05 §4 error route to `checkFolder`, the board frames
// (frames/board.ts), and the boot walks and folder-check schedule started after step 7. The real
// boot step list, the Host dispatcher and connection registry behind in-process duplexes, one copy
// of the template database, a FakeClock and FakeScheduler. Mine folders are real temp folders,
// because mines re-validates a path and checks a folder on the real disk, and the walks are the
// production FsSourceWeightScanner's.
//
// Crew is not constructed by the Host yet (later: ISSUE-094), so host/main.ts binds `noCrewYet`.
// The cases that need a dwarf bind the real crew module's public door instead, as ISSUE-094 will.
//
// TC-093-01, TC-093-02.
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
  methodCapability,
  resFrameSchema,
  sectionCapability,
  type FolderPath
} from '@dwarfai/contracts'
import type { EndOutcome } from '../../kernel/domain/processIdentity'
import type { DwarfId, EventId, HostEpoch, MineId } from '../../kernel/domain/values'
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
import {
  createCrew,
  type CrewEndEvent,
  type EndReason,
  type SessionTerminator
} from '../../modules/crew'
import type { SourceWeightScanner } from '../../modules/mines'
import { FsSourceWeightScanner } from '../../modules/mines/adapters/FsSourceWeightScanner'
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
import { createUpgradeTargetRule } from '../../transport/methods/hostUpgradeRequest'
import { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { FrameClient } from '../../transport/testing/frameClient'
import { inProcessDuplex } from '../../transport/testing/inProcessDuplex'
import { runBoot, type BootOutcome } from '../boot'
import { createBootSteps, mintBootEpoch } from '../bootSteps'
import { emptyDrainGate } from '../emptyDrainGate'
import { createHostDispatcher } from '../hostDispatcher'
import {
  DEFAULT_MINES_SETTINGS,
  noCrewYet,
  serveMines,
  type MinesCrewBinding,
  type MinesRouteEvent,
  type WiredMines
} from '../routes/mines'

const T0 = 1_790_000_000_000
const HOUR_MS = 3_600_000
const WALK_DELAY_MS = DEFAULT_MINES_SETTINGS.automaticWalkDelayMs
const FOLDER_CHECK_MS = DEFAULT_MINES_SETTINGS.folderCheckMs

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

/** A SessionTerminator double whose every end is confirmed by the OS (ADR-014 item 1). */
class EndingTerminator implements SessionTerminator {
  readonly calls: Array<{ dwarfId: DwarfId; why: EndReason }> = []

  end(dwarfId: DwarfId, why: EndReason): Promise<EndOutcome> {
    this.calls.push({ dwarfId, why })
    return Promise.resolve({ kind: 'ended' })
  }

  endAll(): Promise<Map<DwarfId, EndOutcome>> {
    return Promise.reject(new Error('Remove mine ends dwarf by dwarf'))
  }
}

/** A scanner whose walks never answer: a Host stopped mid-walk (S3.25). */
const unansweredScanner: SourceWeightScanner = {
  measure: () => new Promise(() => undefined)
}

interface HostOptions {
  /** The real crew module bound in place of `noCrewYet` (as ISSUE-094 will). */
  crew?: boolean
  /** Another database: a restarted Host over the same file. */
  db?: SqliteDatabase
  scanner?: SourceWeightScanner
}

/**
 * One Host start: the real boot step list, with step 4 wiring mines over the database as
 * host/main.ts does and `startModules` starting its background work, and one `ui` client attached.
 */
async function bootHost(options: HostOptions = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-093-mines-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const processControl = new FakeProcessControl({ bootId: 'boot-one', clock })
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
  // What host/main.ts does before the boot: the members are served before the module exists.
  const served = serveMines({ dispatcher, sections, connections })

  const db = options.db ?? openTemplateCopy().db
  const transactions = new SqliteTransactionRunner(db)
  const bus = new InProcessEventBus<MinesRouteEvent | CrewEndEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => {
      throw failure.error
    }
  })
  const published: Array<MinesRouteEvent | CrewEndEvent> = []
  for (const type of [
    'MineCreated',
    'MineMeasurementStarted',
    'MineMeasured',
    'MineBecameUnenterable',
    'MineRemoved'
  ] as const) {
    bus.subscribe(type, (event) => published.push(event))
  }
  const terminator = new EndingTerminator()
  const crew =
    options.crew === true
      ? createCrew({
          db,
          transactions,
          lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
          bus,
          clock,
          scheduler,
          ids,
          hostEpoch: epoch as HostEpoch,
          links: { owned: () => false, hasDeliveryRoute: () => false }
        })
      : undefined
  const crewBinding: MinesCrewBinding =
    crew === undefined
      ? noCrewYet
      : {
          mineOf: (dwarfId) => crew.queries.get(dwarfId)?.mineId ?? null,
          ends: crew.ends({ terminator, bus }),
          queries: crew.queries
        }

  const host: { wired?: WiredMines } = {}
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
          host.wired = served.wire({
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
            scanner: options.scanner ?? new FsSourceWeightScanner(),
            ...DEFAULT_MINES_SETTINGS,
            crew: crewBinding
          })
        },
        startModules: () => host.wired?.start()
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
  const wired = host.wired
  if (wired === undefined) throw new Error('boot step 4 wired no mines module')

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

  /** A real folder holding one source file of `bytes`. */
  const folder = (name: string, bytes = 2_048): FolderPath => {
    const path = join(root, name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'main.ts'), 'x'.repeat(bytes))
    return path as FolderPath
  }
  /** Every walk, check and route the Host started has answered. */
  const settle = async () => {
    await wired.idle()
    await ui.settle()
  }
  /** The `ui` client's `mines.<method>` answer, validated by the contract. */
  const call = async (method: string, params: unknown) => {
    nextId += 1
    const id = `req-${nextId}`
    ui.send({ type: 'req', id, method, params })
    await ui.until(() => ui.frames.some((frame) => isRes(frame, id)))
    return resFrameSchema.parse(ui.frames.find((frame) => isRes(frame, id)))
  }
  const declare = async (path: FolderPath): Promise<MineId> => {
    const res = await call('mines.declare', { path, requestId: uuid(++nextRequest) })
    if (!res.ok) throw new Error(`mines.declare failed: ${res.error.code}`)
    const result = HOST_METHOD_SCHEMAS['mines.declare'].result.parse(res.result)
    if (!result.ok || !('mineId' in result.value)) throw new Error('no mine declared')
    return result.value.mineId as MineId
  }
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
    db,
    ids,
    epoch,
    bus,
    crew,
    published,
    wired,
    ui,
    terminator,
    folder,
    settle,
    call,
    declare,
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

describe('the mines module wired into the Host (ISSUE-093)', () => {
  it('[S3.04, S3.09] mines.declare on the composed Host creates a measuring mine that the automatic walk makes active', async () => {
    const h = await bootHost()
    const mineId = await h.declare(h.folder('north-seam'))

    // Declared mines start measuring at once (S3.04): the walk is running.
    expect(h.wired.mines.queries.get(mineId)?.state).toBe('measuring')
    await h.settle()

    expect(h.wired.mines.queries.get(mineId)).toMatchObject({ state: 'active', tier: 'bronze' })
    expect(h.published.map((event) => event.type)).toEqual([
      'MineCreated',
      'MineMeasurementStarted',
      'MineMeasured'
    ])
    // The board frames reach the attached UI: the mine's last frame is the measured one.
    expect(h.evts('mine.changed').at(-1)).toMatchObject({ mine: { id: mineId, state: 'active' } })
  })

  it('[S3.01, S3.08] a mine created from an observed session waits unrecorded until the automatic walk measures it', async () => {
    const h = await bootHost()
    const resolved = await h.wired.mines.commands.resolveForSession(h.folder('east-drift'), true)
    if (!('mineId' in resolved)) throw new Error('no mine resolved')
    await h.settle()
    expect(h.wired.mines.queries.get(resolved.mineId)).toMatchObject({
      state: 'unrecorded',
      tier: null
    })

    h.clock.advance(WALK_DELAY_MS)
    expect(h.wired.mines.queries.get(resolved.mineId)?.state).toBe('measuring')
    await h.settle()
    expect(h.wired.mines.queries.get(resolved.mineId)?.state).toBe('active')
  })

  it('[S3.12] a provider error of a dwarf runs checkFolder for its mine through the wired route', async () => {
    const h = await bootHost({ crew: true })
    const path = h.folder('old-shaft')
    const mineId = await h.declare(path)
    await h.settle()
    const crew = h.crew
    if (crew === undefined) throw new Error('no crew bound')
    const dwarfId = crew.commands.arrive({
      mineId,
      identity: { providerId: 'simulated', providerSessionId: 's-lost' },
      rank: 'foreman',
      status: 'working'
    })
    rmSync(path, { recursive: true, force: true })

    h.bus.publish({
      type: 'ProviderErrorObserved',
      v: 1,
      id: h.ids.uuidv7() as EventId,
      at: h.clock.now(),
      hostEpoch: h.epoch as HostEpoch,
      payload: { providerId: 'simulated', cause: 'provider-error', dwarfId }
    })
    await h.settle()

    expect(h.wired.mines.queries.get(mineId)).toMatchObject({
      state: 'unenterable',
      unenterableReason: 'not-found'
    })
    expect(
      h.published.filter((event) => event.type === 'MineBecameUnenterable').map((e) => e.payload)
    ).toEqual([{ mineId, reason: 'not-found' }])
  })

  it('[S3.12] the folder-check schedule starts after boot and checks every mine with a present dwarf', async () => {
    const h = await bootHost({ crew: true })
    const path = h.folder('west-adit')
    const mineId = await h.declare(path)
    await h.settle()
    h.crew?.commands.arrive({
      mineId,
      identity: { providerId: 'simulated', providerSessionId: 's-west' },
      rank: 'foreman',
      status: 'working'
    })
    rmSync(path, { recursive: true, force: true })

    h.clock.advance(FOLDER_CHECK_MS)
    await h.settle()

    expect(h.wired.mines.queries.get(mineId)?.state).toBe('unenterable')
  })

  it('[S3.16] mines.remove on the composed Host removes a mine whose dwarfs all ended', async () => {
    const h = await bootHost({ crew: true })
    const mineId = await h.declare(h.folder('deep-vein'))
    await h.settle()
    const dwarfId = h.crew?.commands.arrive({
      mineId,
      identity: { providerId: 'simulated', providerSessionId: 's-deep' },
      rank: 'foreman',
      status: 'working'
    })

    const res = await h.call('mines.remove', { mineId, requestId: uuid(++nextRequest) })

    expect(res).toMatchObject({ ok: true, result: { ok: true, value: {} } })
    expect(h.terminator.calls).toEqual([{ dwarfId, why: 'remove-mine' }])
    expect(h.wired.mines.queries.get(mineId)).toBeNull()
    expect(h.published.at(-1)).toMatchObject({ type: 'MineRemoved', payload: { mineId } })
    expect(h.evts('mine.removed')).toEqual([{ mineId, removedAt: T0 }])
  })

  it('[S3.25] a mine a stopped Host left measuring is walked again from scratch at the next boot', async () => {
    const first = await bootHost({ scanner: unansweredScanner })
    const mineId = await first.declare(first.folder('south-stope'))
    expect(first.wired.mines.queries.get(mineId)?.state).toBe('measuring')

    const next = await bootHost({ db: first.db })
    await next.settle()

    expect(next.wired.mines.queries.get(mineId)).toMatchObject({ state: 'active', tier: 'bronze' })
  })

  it('[ADR-003] the composed Host advertises section:mines and the mines methods in hello.ok capabilities', async () => {
    const h = await bootHost()
    const helloOk = h.ui.frames[0] as { capabilities: string[] }

    expect(helloOk.capabilities).toEqual(
      expect.arrayContaining([
        methodCapability('mines.declare'),
        methodCapability('mines.adoptMainProject'),
        methodCapability('mines.remove'),
        methodCapability('mines.list'),
        methodCapability('mines.resolveFile'),
        sectionCapability('mines')
      ])
    )
  })
})
