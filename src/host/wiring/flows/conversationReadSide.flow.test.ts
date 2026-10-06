// layer: L2
// L2 flow (17 §1.2; 16 §8.2, §8.3; 05 §4): the conversation read side wired into the Host through
// host/wiring/routes/conversation.ts and routes/conversationFrames.ts, as host/main.ts wires it:
// B-M26 `conversation.feed`, B-M27 `conversation.mineHistory` and the `tails` section served
// before the boot binds the endpoint (14 §1.3), the module constructed at boot step 4 over the
// one `SqliteLifecycleFactLog` crew shares, its half of the `ObservedBatchSink` bridge
// (bridges/observedBatchSink.ts, AMENDMENT-10) and its events turned into frames for the 14 §2.4
// audiences. With the conversation half in place the bridge's sink is real, so step 7 starts
// observation through `WiredObservation.start` and the coal backfills run through
// `startBackfillWhenObserving` and `routeMineBackfillWhenObserving` (O-11-10), each gated by the
// cut-1 rollback choice (wiring/cut1Rollback.ts, ISSUE-122).
//
// The real boot step list, the Host dispatcher and connection registry behind in-process duplexes
// (frames validated against their contract schemas), one copy of the template database, a
// FakeClock, FakeScheduler and FakeProcessControl. The read-side cases seed one mine and its present
// dwarf and drive conversation's own commands and the bridge directly: the cross-epic routes
// (`ObservedTurnEnded` → `recordTurnEnd`, turn ends into crew and attention) are ISSUE-120's. The
// observation cases lay out Claude in a per-test temp home folder in its real spelling (17 §5.3)
// with the recorded fixture `fixtures/claude/observer/2.1.x/usage-rows.jsonl` (synthetic,
// scrubbed), whose working folder is rewritten to a real temp folder. No test reads the person's
// home folder or a provider credential (AGENTS §6). Every message text here is invented.
//
// TC-108-01, TC-108-02, TC-108-03.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  frameCapability,
  HOST_FRAME_SCHEMAS,
  methodCapability,
  PROTOCOL_VERSION,
  resFrameSchema,
  sectionCapability
} from '@dwarfai/contracts'
import type { DwarfId, FolderPath, HostEpoch, Instant, MineId } from '../../kernel/domain/values'
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
import { ProviderHistoryScanner } from '../../modules/ledger/adapters/ProviderHistoryScanner'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
import { createHostGitRepoInspector } from '../../modules/mines/adapters/FsGitRepoInspector'
import { FsSourceWeightScanner } from '../../modules/mines/adapters/FsSourceWeightScanner'
import {
  OBSERVATION_POLL_MS,
  createSqliteObservationStores,
  type ObservedBatchSink
} from '../../modules/observation'
import type { ConversationEntry } from '../../modules/suppliers'
import { NodeFs } from '../../platform/fs/NodeFs'
import { openReadOnlySnapshot } from '../../platform/sqlite/readOnlySnapshot'
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
import { composeObservedBatchSink } from '../bridges/observedBatchSink'
import { cut1RollbackChoices } from '../cut1Rollback'
import { emptyDrainGate } from '../emptyDrainGate'
import { createHostDispatcher } from '../hostDispatcher'
import {
  serveConversation,
  type ConversationRouteEvent,
  type WiredConversation
} from '../routes/conversation'
import { CONVERSATION_READ_FRAMES } from '../routes/conversationFrames'
import { serveCrew, type CrewRouteEvent, type WiredCrew } from '../routes/crew'
import {
  routeMineBackfillWhenObserving,
  startBackfillWhenObserving,
  wireLedger,
  type LedgerRouteEvent,
  type WiredLedger
} from '../routes/ledger'
import {
  DEFAULT_MINES_SETTINGS,
  serveMines,
  type MinesRouteEvent,
  type WiredMines
} from '../routes/mines'
import {
  observationAdapters,
  observedProviderFolders,
  wireObservation,
  type WiredObservation
} from '../routes/observation'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures')
const SESSION_ID = '01a0b000-0000-7000-8000-000000000712'
const FIXTURE_CWD = '/home/j/work/sample-project'

/** The fixture's three sealed units (usage-rows.expected.json). */
const UNIT_C = 'msg_01UsageRowsC'
const UNIT_D = 'msg_01UsageRowsD'
const UNIT_E = 'msg_01UsageRowsE'
/** Between unit D (11:00:07) and unit E (11:00:22): C and D are history (coal), E is live usage. */
const INSTALL_BETWEEN_D_AND_E = 1_790_766_010_000 as Instant
/** The Hosts start after the fixture was written. */
const T0 = 1_790_800_000_000 as Instant

const MINE = '00000000-0000-7000-8000-0000000108a1' as MineId
const DWARF = '00000000-0000-7000-8000-0000000108d1' as DwarfId

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** `text` with every JSON-escaped spelling of `from` replaced by `to`. */
function jsonPathSwap(text: string, from: string, to: string): string {
  return text.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1))
}

/** A temp root: a home folder with Claude's folders, the mine's folder and the Host database. */
function world() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-108-conversation-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const folders = observedProviderFolders({}, join(root, 'home'))
  const cwd = join(root, 'mines', 'sample')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'main.ts'), 'x'.repeat(2_048))
  const project = join(folders.claudeConfigDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  const { db } = openTemplateCopy()
  db.exec(`DELETE FROM install_moment`)
  db.run(`INSERT INTO install_moment (id, at, reason) VALUES (1, ?, 'fresh-install')`, [
    INSTALL_BETWEEN_D_AND_E
  ])
  return {
    root,
    folders,
    cwd: cwd as FolderPath,
    db,
    processes: new FakeProcessControl({ bootId: 'boot-a' }),
    /** One mine on the board and its present dwarf, as an earlier Host left them. */
    seedDwarf: () => {
      const seed = new SqliteTransactionRunner(db)
      seed.inTransaction(() => {
        db.run(
          `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
           VALUES (?, '/work/moria', 'moria', 'moria', 'active', ?, ?)`,
          [MINE, T0, T0]
        )
        db.run(
          `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
             process_state, turn_state, arrived_at, last_activity_at)
           VALUES (?, ?, 'claude', 'session-a', 'Gimli', 'foreman', 'running', 'none-yet', ?, ?)`,
          [DWARF, MINE, T0, T0]
        )
      })
    },
    /** The Claude session writes its transcript (the fixture, in this mine's folder). */
    writeTranscript: () =>
      writeFileSync(
        join(project, `${SESSION_ID}.jsonl`),
        jsonPathSwap(
          readFileSync(join(FIXTURES, 'claude/observer/2.1.x/usage-rows.jsonl'), 'utf8'),
          FIXTURE_CWD,
          cwd
        )
      )
  }
}
type World = ReturnType<typeof world>

/**
 * One Host start over `world`, composed as host/main.ts composes it: the members served before the
 * bind, step 4 wiring the ledger, conversation, the bridge (through the rollback choice of a build
 * whose setting is `rolledBack`), observation, crew and mines, step 7 through the wiring's `start`,
 * and after `ready` the coal backfill through its gate.
 */
async function bootHost(options: { world: World; rolledBack?: boolean }) {
  const { db, processes, folders } = options.world
  const rollback = cut1RollbackChoices(options.rolledBack ?? false)
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
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
  const servedConversation = serveConversation({ dispatcher, sections })

  const transactions = new SqliteTransactionRunner(db)
  const bus = new InProcessEventBus<
    MinesRouteEvent | CrewRouteEvent | LedgerRouteEvent | ConversationRouteEvent
  >({
    transactionScope: transactions,
    onHandlerError: (failure) => {
      throw failure.error
    }
  })
  const fs = new NodeFs()
  const host: {
    ledger?: WiredLedger
    conversation?: WiredConversation
    observation?: WiredObservation
    crew?: WiredCrew
    mines?: WiredMines
    sink?: ObservedBatchSink
    batches?: ReturnType<typeof composeObservedBatchSink>
    perMineBackfill?: boolean
  } = {}
  const boot: Promise<BootOutcome> = runBoot(
    (paths) =>
      createBootSteps({
        paths,
        clock,
        scheduler,
        ids,
        fs: new FakeFs(),
        processControl: processes,
        log,
        endpoint: { bind: () => Promise.resolve('bound'), close: () => Promise.resolve() },
        database: { open: () => Promise.resolve() },
        constructModules: () => {
          const ledger = wireLedger({
            repository: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
            transactions,
            bus,
            clock,
            ids,
            hostEpoch: epoch as HostEpoch,
            log,
            frames: connections,
            resolver: createHostGitRepoInspector({ fs, clock }),
            scanner: (resolveMine) =>
              new ProviderHistoryScanner({
                fs,
                clock,
                openSnapshot: openReadOnlySnapshot,
                claudeRoots: [folders.claudeConfigDir],
                codexHome: folders.codexHome,
                opencodeStoreRoot: folders.openCodeStoreRoot,
                resolveMine
              })
          })
          // One kernel LifecycleFactLog, shared by crew and conversation (05 §4).
          const lifecycleFacts = new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock })
          const conversation = servedConversation.wire({
            db,
            transactions,
            lifecycleFacts,
            bus,
            clock,
            ids,
            hostEpoch: epoch as HostEpoch,
            frames: connections
          })
          const batches = composeObservedBatchSink({
            transactions,
            ledger: ledger.batchHalf,
            conversation: conversation.batchHalf
          })
          // What host/main.ts does: the batch sink is the rollback choice's.
          const sink = rollback.observedBatchSink(batches.sink)
          const observation = wireObservation({
            stores: createSqliteObservationStores({ db, scope: transactions, clock }),
            ...observationAdapters({
              folders,
              fs,
              clock,
              processes,
              openSnapshot: openReadOnlySnapshot
            }),
            sink,
            transactions: batches.transactions,
            bus,
            fs,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch as HostEpoch,
            log
          })
          const crew = servedCrew.wire({
            db,
            transactions,
            lifecycleFacts,
            bus,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch as HostEpoch,
            log,
            links: { owned: () => false, hasDeliveryRoute: () => false },
            processes,
            observation: observation.crew,
            outcomes: conversation.conversation.queries
          })
          const mines = servedMines.wire({
            db,
            transactions,
            bus,
            clock,
            scheduler,
            ids,
            fs,
            hostEpoch: epoch as HostEpoch,
            log,
            mapSites: [],
            random: () => 0,
            scanner: new FsSourceWeightScanner(),
            ...DEFAULT_MINES_SETTINGS,
            crew: crew.mines,
            ledger: ledger.totals,
            outcomes: conversation.conversation.queries
          })
          crew.route({ commands: mines.mines.commands, queries: mines.mines.queries })
          ledger.route({ mines: mines.mines.queries })
          conversation.route({ crew: crew.crew.queries, mines: mines.mines.queries })
          const perMineBackfill = routeMineBackfillWhenObserving(ledger, bus, sink)
          Object.assign(host, {
            ledger,
            conversation,
            observation,
            crew,
            mines,
            sink,
            batches,
            perMineBackfill
          })
        },
        startObservation: () => {
          if (host.observation === undefined) throw new Error('step 7 before step 4')
          host.observation.start?.()
        },
        startModules: () => host.mines?.start()
      }),
    {
      log,
      clock,
      state,
      privilege: () =>
        Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
      paths: { ok: true, value: new FakeAppPaths({ userDataDir: options.world.root }) },
      runtime: { os: 'win32', arch: 'x64', node: '24.18.1' },
      exit: () => undefined
    }
  )
  expect(await boot).toEqual({ kind: 'ready' })
  const { ledger, conversation, observation, crew, mines, sink, batches } = host
  if (
    ledger === undefined ||
    conversation === undefined ||
    observation === undefined ||
    crew === undefined ||
    mines === undefined ||
    sink === undefined ||
    batches === undefined
  ) {
    throw new Error('boot step 4 wired no module')
  }
  // A case that fails before its own stop still ends the loop before the database closes.
  onTestFinished(() => observation.observation.control.stop())
  // After `ready`, as host/main.ts does (S19.02): through the same gate as observation.
  const backfill = startBackfillWhenObserving(ledger, sink)

  const token = new UiToken()
  await token.issue(join(options.world.root, 'run'))
  const secret = readFileSync(join(options.world.root, 'run', UI_TOKEN_FILE), 'utf8')
  /** A client of `role` attached over its own in-process duplex, its hello.ok received. */
  const attach = async (role: 'ui' | 'notifier') => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: {
        hostVersion: '0.0.0-test',
        buildId: 'abc1234',
        protocolVersion: PROTOCOL_VERSION
      },
      epoch,
      state: () => state.current(),
      // The frames host/main.ts advertises for these modules.
      capabilities: () =>
        collectCapabilities({
          methods: dispatcher.methods(),
          frames: [...BOARD_FRAMES, ...CONVERSATION_READ_FRAMES],
          sections: sections.names()
        }),
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle: new HelloThrottle(clock)
    })
    const client = new FrameClient(pair.client)
    onTestFinished(async () => {
      pair.client.destroy()
      await client.settle()
    })
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: secret,
      client: { appVersion: '0.0.0-test', buildId: 'abc1234', pid: 4242 }
    })
    await client.until(() => client.frames.length > 0)
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }
  let nextId = 0
  /** `client`'s answer to `method`, validated by the contract. */
  const call = async (client: FrameClient, method: string, params: unknown) => {
    nextId += 1
    const id = `req-${nextId}`
    client.send({ type: 'req', id, method, params })
    await client.until(() => client.frames.some((frame) => isRes(frame, id)))
    return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
  }
  /** Every cycle, route, walk and check the Host started has answered. */
  const settle = async (...clients: FrameClient[]) => {
    for (let round = 0; round < 5; round += 1) {
      await observation.idle()
      await crew.idle()
      await mines.idle()
      for (const client of clients) await client.settle()
      await tick()
    }
  }
  return {
    clock,
    log,
    sections,
    ledger,
    conversation,
    crew,
    mines,
    sink,
    batches,
    backfill,
    perMineBackfill: host.perMineBackfill,
    attach,
    call,
    settle,
    /** One poll of the live loop, then everything it caused. */
    poll: async (...clients: FrameClient[]) => {
      await settle(...clients)
      clock.advance(OBSERVATION_POLL_MS)
      await settle(...clients)
    },
    /** Lets every per-mine and full coal backfill run started so far finish. */
    backfills: async () => {
      await backfill
      for (let round = 0; round < 5; round += 1) await tick()
    },
    /** The Host stops (S4.37): its loop ends and nothing more is read. */
    stop: () => observation.observation.control.stop()
  }
}

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id?: string }).id === id
  )
}

/** The `name` frames `client` received, their data. */
function evts(client: FrameClient, name: string): unknown[] {
  return client.frames.flatMap((frame) => {
    if ((frame as { type?: string }).type !== 'evt') return []
    const evt = evtFrameSchema.parse(frame)
    return evt.name === name ? [evt.data] : []
  })
}

/** Every evt frame name `client` received. */
function evtNames(client: FrameClient): string[] {
  return client.frames.flatMap((frame) =>
    (frame as { type?: string }).type === 'evt' ? [(frame as { name: string }).name] : []
  )
}

/** One observed message entry of the seeded dwarf. */
function entry(n: number, role: ConversationEntry['role'], text: string): ConversationEntry {
  return {
    sourceKey: `claude:session-a:event-${n}`,
    role,
    text,
    providerTime: (T0 + n) as Instant
  }
}

/** `e` with one folded tool step (15 §1.2 `ActivityStep`), its summary one invented line. */
function withStep(e: ConversationEntry, n: number): ConversationEntry {
  return {
    ...e,
    activity: [
      {
        sourceKey: `claude:session-a:tool-${n}`,
        turnKey: 'turn-1',
        kind: 'tool',
        toolName: 'Read',
        summary: `Read step ${n}`,
        state: 'finished',
        at: (T0 + n) as Instant
      }
    ]
  }
}

function count(db: SqliteDatabase, sql: string, params: unknown[] = []): number {
  return Number(db.all(sql, params as never)[0]?.['n'])
}

describe('the conversation read side wired into the Host (ISSUE-108)', () => {
  it('[ADR-003] after boot hello.ok advertises conversation.feed, conversation.mineHistory, section:tails and the frames conversation.appended, activity.changed and turn.ended', async () => {
    const w = world()
    const h = await bootHost({ world: w })

    const ui = await h.attach('ui')

    const capabilities = (ui.frames[0] as { capabilities: readonly string[] }).capabilities
    expect(capabilities).toEqual(
      expect.arrayContaining([
        methodCapability('conversation.feed'),
        methodCapability('conversation.mineHistory'),
        sectionCapability('tails'),
        frameCapability('conversation.appended'),
        frameCapability('activity.changed'),
        frameCapability('turn.ended'),
        frameCapability('dwarf.changed')
      ])
    )
    h.stop()
  })

  it('[ADR-007] an ingest batch reaches an attached ui client as one conversation.appended frame after the commit and a rolled-back batch sends none', async () => {
    const w = world()
    w.seedDwarf()
    const h = await bootHost({ world: w })
    const ui = await h.attach('ui')

    // Observation's batch, as it runs one: the sink inside the bridge's runner.
    h.batches.transactions.inTransaction(() =>
      h.sink.apply({
        dwarfId: DWARF,
        entries: [entry(1, 'person', 'Is the vein deep?'), entry(2, 'dwarf', 'Very deep.')],
        usage: []
      })
    )
    // A batch whose transaction fails after the sink ran: nothing of it is stored or sent.
    expect(() =>
      h.batches.transactions.inTransaction(() => {
        h.sink.apply({ dwarfId: DWARF, entries: [entry(3, 'dwarf', 'Lost words.')], usage: [] })
        throw new Error('the cursor could not advance')
      })
    ).toThrow('the cursor could not advance')
    await h.settle(ui)
    h.stop()

    const appended = evts(ui, 'conversation.appended') as Array<{
      dwarfId: DwarfId
      messages: Array<{ role: string; text: string }>
    }>
    expect(appended).toHaveLength(1)
    expect(appended[0]?.dwarfId).toBe(DWARF)
    // The rows the batch inserted, in batch order (08 §0); the feed pages newest first.
    expect(appended[0]?.messages.map((m) => [m.role, m.text])).toEqual([
      ['person', 'Is the vein deep?'],
      ['dwarf', 'Very deep.']
    ])
    expect(count(w.db, `SELECT COUNT(*) AS n FROM messages WHERE dwarf_id = ?`, [DWARF])).toBe(2)
    // B-M26 pages the same rows the frame carried (14 §3.6 `MessageView`).
    const feed = await h.call(ui, 'conversation.feed', { dwarfId: DWARF })
    expect(feed).toMatchObject({ ok: true })
    const page = (feed.ok ? feed.result : null) as { messages: Array<{ text: string }> } | null
    expect(page?.messages.map((m) => m.text)).toEqual(['Very deep.', 'Is the vein deep?'])
  })

  it('[ADR-021] a recorded turn end reaches the ui as one turn.ended frame; a replay of the same turnKey sends none', async () => {
    const w = world()
    w.seedDwarf()
    const h = await bootHost({ world: w })
    const ui = await h.attach('ui')

    const end = {
      dwarfId: DWARF,
      turnKey: 'turn-1',
      kind: 'concluded' as const,
      at: T0 + 10,
      reliability: 'reliable' as const,
      cancelledFromApp: false
    }
    h.conversation.conversation.commands.recordTurnEnd(end)
    h.conversation.conversation.commands.recordTurnEnd(end)
    await h.settle(ui)
    h.stop()

    expect(evts(ui, 'turn.ended')).toStrictEqual([
      {
        dwarfId: DWARF,
        turnKey: 'turn-1',
        kind: 'concluded',
        reliability: 'reliable',
        cancelledFromApp: false
      }
    ])
  })

  it('[INV-67] an outcome change reaches the ui as dwarf.changed carrying the new outcome line', async () => {
    const w = world()
    w.seedDwarf()
    const h = await bootHost({ world: w })
    const ui = await h.attach('ui')

    h.conversation.conversation.commands.recordTurnEnd({
      dwarfId: DWARF,
      turnKey: 'turn-1',
      kind: 'concluded',
      at: T0 + 10,
      reliability: 'reliable',
      cancelledFromApp: false
    })
    await h.settle(ui)
    h.stop()

    const changed = evts(ui, 'dwarf.changed') as Array<{
      dwarf: { id: DwarfId; outcome?: { dwarfId: DwarfId; kind: string; reliability: string } }
    }>
    expect(changed.at(-1)?.dwarf.id).toBe(DWARF)
    expect(changed.at(-1)?.dwarf.outcome).toMatchObject({
      dwarfId: DWARF,
      kind: 'concluded',
      reliability: 'reliable',
      at: T0 + 10
    })
  })

  it('[S11.03] a run closing reaches the ui as activity.changed with open false', async () => {
    const w = world()
    w.seedDwarf()
    const h = await bootHost({ world: w })
    const ui = await h.attach('ui')

    // Two tool steps open and grow the dwarf's run; the dwarf speaking closes it (07 S11.03).
    h.batches.transactions.inTransaction(() =>
      h.sink.apply({
        dwarfId: DWARF,
        entries: [withStep(entry(1, 'dwarf', ''), 1), withStep(entry(2, 'dwarf', ''), 2)],
        usage: []
      })
    )
    await h.settle(ui)
    h.batches.transactions.inTransaction(() =>
      h.sink.apply({ dwarfId: DWARF, entries: [entry(3, 'dwarf', 'The seam holds.')], usage: [] })
    )
    await h.settle(ui)
    h.stop()

    const changes = evts(ui, 'activity.changed') as Array<{ disclosureId: string }>
    expect(changes).toStrictEqual([
      {
        dwarfId: DWARF,
        disclosureId: changes[0]?.disclosureId,
        open: true,
        stepCount: 2,
        summaries: ['Read step 1', 'Read step 2']
      },
      {
        dwarfId: DWARF,
        disclosureId: changes[0]?.disclosureId,
        open: false,
        stepCount: 2,
        summaries: ['Read step 1', 'Read step 2']
      }
    ])
  })

  it("[INV-67] a reconnecting ui's snapshot shows each dwarf's stored outcome line, and every later dwarf.changed carries it", async () => {
    const w = world()
    w.seedDwarf()
    const first = await bootHost({ world: w })
    first.conversation.conversation.commands.recordTurnEnd({
      dwarfId: DWARF,
      turnKey: 'turn-1',
      kind: 'concluded',
      at: T0 + 10,
      reliability: 'reliable',
      cancelledFromApp: false
    })
    await first.settle()
    first.stop()

    // The next Host over the same database; a ui attaches and reads the board.
    const h = await bootHost({ world: w })
    const ui = await h.attach('ui')
    const snapshot = await h.call(ui, 'session.snapshot', { sections: ['dwarfs'] })
    // A status change of the dwarf (crew's board frame) after the snapshot.
    h.crew.crew.commands.recordActivity(DWARF, 'turn-started')
    await h.settle(ui)
    h.stop()

    const stored = { dwarfId: DWARF, kind: 'concluded', reliability: 'reliable', at: T0 + 10 }
    const page = (snapshot.ok ? snapshot.result : null) as {
      chunks: Array<{ section: string; data: Array<{ id: DwarfId; outcome?: unknown }> }>
    } | null
    const dwarfs = page?.chunks.find((chunk) => chunk.section === 'dwarfs')?.data
    expect(dwarfs?.map((dwarf) => dwarf.id)).toEqual([DWARF])
    expect(dwarfs?.[0]?.outcome).toMatchObject(stored)
    const changed = evts(ui, 'dwarf.changed') as Array<{ dwarf: { outcome?: unknown } }>
    expect(changed.length).toBeGreaterThan(0)
    for (const frame of changed) expect(frame.dwarf.outcome).toMatchObject(stored)
  })

  it('[ADR-003] a notifier connection receives none of these frames', async () => {
    const w = world()
    w.seedDwarf()
    const h = await bootHost({ world: w })
    const notifier = await h.attach('notifier')
    const ui = await h.attach('ui')

    h.batches.transactions.inTransaction(() =>
      h.sink.apply({
        dwarfId: DWARF,
        entries: [withStep(entry(1, 'dwarf', 'Struck gold.'), 1)],
        usage: []
      })
    )
    h.conversation.conversation.commands.recordTurnEnd({
      dwarfId: DWARF,
      turnKey: 'turn-1',
      kind: 'concluded',
      at: T0 + 10,
      reliability: 'reliable',
      cancelledFromApp: false
    })
    await h.settle(notifier, ui)
    h.stop()

    // The ui got them, so they were sent; the notifier role is in no 14 §2.4 audience of them.
    expect(evtNames(ui)).toEqual(
      expect.arrayContaining([
        'conversation.appended',
        'activity.changed',
        'turn.ended',
        'dwarf.changed'
      ])
    )
    expect(
      evtNames(notifier).filter((name) =>
        ['conversation.appended', 'turn.ended', 'dwarf.changed', 'activity.changed'].includes(name)
      )
    ).toEqual([])
  })

  it('[ADR-007] the mine history and the tails section read the message log of the present dwarf', async () => {
    const w = world()
    w.seedDwarf()
    const h = await bootHost({ world: w })
    const ui = await h.attach('ui')
    h.batches.transactions.inTransaction(() =>
      h.sink.apply({ dwarfId: DWARF, entries: [entry(1, 'dwarf', 'Struck gold.')], usage: [] })
    )
    await h.settle(ui)

    const history = await h.call(ui, 'conversation.mineHistory', { mineId: MINE })
    h.stop()

    expect(history).toMatchObject({
      ok: true,
      result: {
        mineId: MINE,
        speakers: [{ dwarfId: DWARF, departed: false, messages: [{ text: 'Struck gold.' }] }]
      }
    })
    // The `tails` section: the present dwarf's newest rows (14 §3.7), for `ui` only.
    expect(h.sections.get('tails')?.provider()).toMatchObject([
      { dwarfId: DWARF, messages: [{ text: 'Struck gold.' }], reachedStart: true }
    ])
  })
})

describe('observation turned on by the conversation half (ISSUE-108)', () => {
  it('[ADR-007, ADR-006] the Host observes: an observed transcript reaches the message log and its usage is credited once', async () => {
    const w = world()
    w.writeTranscript()
    const h = await bootHost({ world: w })
    expect(h.backfill).not.toBeNull()
    expect(h.perMineBackfill).toBe(true)
    const ui = await h.attach('ui')

    for (let i = 0; i < 3; i += 1) await h.poll(ui)
    h.clock.advance(DEFAULT_MINES_SETTINGS.automaticWalkDelayMs)
    await h.poll(ui)
    await h.backfills()
    await h.settle(ui)
    h.stop()

    // The session's mine and dwarf arrived through observation's routes; its messages are stored.
    const dwarfs = w.db.all(`SELECT id FROM dwarfs`)
    expect(dwarfs).toHaveLength(1)
    const dwarfId = dwarfs[0]!['id'] as DwarfId
    expect(count(w.db, `SELECT COUNT(*) AS n FROM messages WHERE dwarf_id = ?`, [dwarfId])).toBe(
      evts(ui, 'conversation.appended').flatMap(
        (data) => (data as { messages: unknown[] }).messages
      ).length
    )
    expect(
      count(w.db, `SELECT COUNT(*) AS n FROM messages WHERE dwarf_id = ?`, [dwarfId])
    ).toBeGreaterThan(0)
    // Each sealed unit credited once: C and D (before the install moment) as coal by the per-mine
    // backfill of the mine observation created (O-11-10), E as live usage.
    const entries = w.db
      .all(`SELECT unit_key, material, kind FROM ledger_entries ORDER BY unit_key`)
      .map((row) => [String(row['unit_key']), String(row['material']), String(row['kind'])])
    expect(entries.map(([unit]) => unit)).toEqual([UNIT_C, UNIT_D, UNIT_E])
    expect(entries.filter(([, material]) => material === 'coal').map(([unit]) => unit)).toEqual([
      UNIT_C,
      UNIT_D
    ])
    expect(entries.find(([unit]) => unit === UNIT_E)?.[2]).toBe('live')
  })

  it('[ADR-001] with the cut-1 rollback choices on, observation, the coal backfill and the per-mine backfill never start', async () => {
    const w = world()
    w.writeTranscript()
    const h = await bootHost({ world: w, rolledBack: true })
    const ui = await h.attach('ui')

    for (let i = 0; i < 3; i += 1) await h.poll(ui)
    // A mine the person declares (`MineCreated`): the per-mine backfill is not routed either.
    const declared = await h.mines.mines.commands.declare(w.cwd)
    expect(declared.ok).toBe(true)
    await h.backfills()
    await h.settle(ui)
    h.stop()

    expect(h.backfill).toBeNull()
    expect(h.perMineBackfill).toBe(false)
    expect(count(w.db, `SELECT COUNT(*) AS n FROM observed_sessions`)).toBe(0)
    expect(count(w.db, `SELECT COUNT(*) AS n FROM messages`)).toBe(0)
    expect(count(w.db, `SELECT COUNT(*) AS n FROM ledger_entries`)).toBe(0)
    expect(evts(ui, 'conversation.appended')).toEqual([])
  })
})
