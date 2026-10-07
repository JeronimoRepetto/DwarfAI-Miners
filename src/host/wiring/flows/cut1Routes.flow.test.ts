// layer: L2
// L2 flow (17 §1.2; 05 §4; 08 §2.2, §2.3, §2.6, §5; 16 §8.2, §8.3): the cut-1 cross-epic event routes
// (host/wiring/routes/cut1Routes.ts, ISSUE-120) over the Host composition as host/main.ts builds it:
// the members served before the bind, step 4 wiring the ledger, conversation, the `ObservedBatchSink`
// bridge, observation over the four real provider adapters, crew, mines, the conversation routes,
// attention over the `SqliteAttentionLedger`, the `TransportLevel3Sink` (through the cut-1 rollback
// choice) and the `AppBackgroundNotifierLauncher` over FakeProcessControl (no app is ever started),
// and then the cut-1 routes; step 7 starts observation through `WiredObservation.start`.
//
// The real boot step list, the Host dispatcher and connection registry behind in-process duplexes,
// one `ui` and one `notifier` client (frames validated against their contract schemas; no OS
// notification is ever drawn), one copy of the template database, a FakeClock, FakeScheduler and
// FakeProcessControl. The providers are Codex (reliable turn ends) and Claude (transcript-only,
// inferred turn ends), laid out in a per-test temp home folder in their real spelling (17 §5.3)
// with the recorded fixtures `fixtures/codex/observer/0.153.x/turn-with-usage.jsonl`,
// `turn-aborted.jsonl` and `fixtures/claude/observer/2.1.x/turn-ends.jsonl` (synthetic, scrubbed),
// whose working folder is rewritten to a real temp folder declared as a mine. No test reads the
// person's home folder or a provider credential (AGENTS §6).
//
// TC-120-01, TC-120-02, TC-120-03.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  HOST_FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema
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
import type { DomainEvent } from '../../kernel/domain/domainEvent'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { AppBackgroundNotifierLauncher } from '../../modules/attention/adapters/AppBackgroundNotifierLauncher'
import { SqliteAttentionLedger } from '../../modules/attention/adapters/SqliteAttentionLedger'
import { ProviderHistoryScanner } from '../../modules/ledger/adapters/ProviderHistoryScanner'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
import { createHostGitRepoInspector } from '../../modules/mines/adapters/FsGitRepoInspector'
import { FsSourceWeightScanner } from '../../modules/mines/adapters/FsSourceWeightScanner'
import { OBSERVATION_POLL_MS, createSqliteObservationStores } from '../../modules/observation'
import { NodeFs } from '../../platform/fs/NodeFs'
import { openReadOnlySnapshot } from '../../platform/sqlite/readOnlySnapshot'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { TransportLevel3Sink } from '../../transport/attention/TransportLevel3Sink'
import { HelloThrottle } from '../../transport/auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../../transport/auth/uiToken'
import { collectCapabilities } from '../../transport/capabilities'
import { acceptConnection } from '../../transport/connection'
import { ConnectionRegistry } from '../../transport/connectionRegistry'
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
  ATTENTION_FRAMES,
  onNotifierAttach,
  serveAttention,
  type AttentionRouteEvent,
  type WiredAttention
} from '../routes/attentionTransport'
import {
  serveConversation,
  type ConversationRouteEvent,
  type WiredConversation
} from '../routes/conversation'
import { CONVERSATION_READ_FRAMES } from '../routes/conversationFrames'
import { serveCrew, type CrewRouteEvent, type WiredCrew } from '../routes/crew'
import { routeCut1Events } from '../routes/cut1Routes'
import { wireLedger, type LedgerRouteEvent } from '../routes/ledger'
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
const CODEX_FIXTURES = join(FIXTURES, 'codex/observer/0.153.x')
const CLAUDE_FIXTURES = join(FIXTURES, 'claude/observer/2.1.x')

/** turn-with-usage.jsonl: the session and its two reliable turn ends (turn-with-usage.expected.json). */
const CODEX_SESSION = '01a0b000-0000-7000-8000-000000000731'
const CODEX_TURN_1 = '01a0b000-0000-7000-8000-0000000007a1'
const CODEX_TURN_2 = '01a0b000-0000-7000-8000-0000000007a2'
/** turn-aborted.jsonl: a second Codex session (a subagent of the first) and its last turn end. */
const ABORTED_SESSION = '01a0b000-0000-7000-8000-000000000732'
const ABORTED_TURN_2 = '01a0b000-0000-7000-8000-0000000007b2'
/** turn-ends.jsonl: a transcript-only Claude session. */
const CLAUDE_SESSION = '01a0b000-0000-7000-8000-000000000715'

/** turn-with-usage.jsonl's lines: 1–11 the first turn up to its answer, 12 its end, 13 the next turn's start. */
const CODEX_FIRST_TURN_OPEN = 11
const CODEX_FIRST_TURN_ENDED = 12
const CODEX_SECOND_TURN_STARTED = 13

/** The Codex fixtures' first record is 2026-09-30T10:00:00Z; the Host starts just before it. */
const CODEX_T0 = 1_790_762_398_000 as Instant
/** The Claude fixture's last turn ends at 1790776851000; the Host starts just before it. */
const CLAUDE_T0 = 1_790_776_850_000 as Instant
/** Before every record of the fixtures: everything they hold is live usage. */
const INSTALL_BEFORE_ALL = 1_790_700_000_000 as Instant

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

/** A fixture's non-empty lines, its working folder rewritten to `cwd`. */
function fixtureLines(path: string, fixtureCwd: string, cwd: string): string[] {
  return jsonPathSwap(readFileSync(path, 'utf8'), fixtureCwd, cwd)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
}

/** A temp root: a home folder with the providers' folders, the mine's folder and the Host database. */
function world() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-120-routes-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const folders = observedProviderFolders({}, join(root, 'home'))
  const cwd = join(root, 'mines', 'moria')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'main.ts'), 'x'.repeat(2_048))
  const { db } = openTemplateCopy()
  db.exec(`DELETE FROM install_moment`)
  db.run(`INSERT INTO install_moment (id, at, reason) VALUES (1, ?, 'fresh-install')`, [
    INSTALL_BEFORE_ALL
  ])
  const codexFolder = join(folders.codexHome, 'sessions', '2026', '09', '30')
  mkdirSync(codexFolder, { recursive: true })
  const claudeProject = join(folders.claudeConfigDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(claudeProject, { recursive: true })
  const codex = (name: string, fixtureCwd: string) => ({
    lines: fixtureLines(join(CODEX_FIXTURES, `${name}.jsonl`), fixtureCwd, cwd),
    path: join(codexFolder, `rollout-2026-09-30T10-00-00-${name}.jsonl`)
  })
  const transcripts = {
    'turn-with-usage': codex('turn-with-usage', 'C:\\Users\\j\\Desktop\\Sample-Project'),
    'turn-aborted': codex('turn-aborted', '/home/j/work/sample-project'),
    'turn-ends': {
      lines: fixtureLines(
        join(CLAUDE_FIXTURES, 'turn-ends.jsonl'),
        '/home/j/work/sample-project',
        cwd
      ),
      path: join(claudeProject, `${CLAUDE_SESSION}.jsonl`)
    }
  }
  return {
    root,
    folders,
    cwd: cwd as FolderPath,
    db,
    processes: new FakeProcessControl({ bootId: 'boot-a' }),
    /** The provider writes the first `count` records of its transcript (all of them by default). */
    write: (name: keyof typeof transcripts, count?: number) => {
      const { lines, path } = transcripts[name]
      writeFileSync(
        path,
        lines
          .slice(0, count ?? lines.length)
          .map((line) => `${line}\n`)
          .join('')
      )
    }
  }
}
type World = ReturnType<typeof world>

type HostBusEvent =
  MinesRouteEvent | CrewRouteEvent | LedgerRouteEvent | ConversationRouteEvent | AttentionRouteEvent

/**
 * One Host start over `world`, composed as host/main.ts composes it (step 4 ending with the cut-1
 * routes), every event the bus carried recorded.
 */
async function bootHost(options: { world: World; startAt: Instant }) {
  const { db, processes, folders } = options.world
  const rollback = cut1RollbackChoices(false)
  const clock = new FakeClock(options.startAt)
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
  const servedAttention = serveAttention({ dispatcher, connections })

  const transactions = new SqliteTransactionRunner(db)
  const bus = new InProcessEventBus<HostBusEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => {
      throw failure.error
    }
  })
  /** Every event the Host bus carried, in publish order. */
  const published: Array<DomainEvent<string, unknown>> = []
  const record = bus.publish.bind(bus)
  bus.publish = (event) => {
    published.push(event)
    record(event)
  }
  const fs = new NodeFs()
  const host: {
    conversation?: WiredConversation
    observation?: WiredObservation
    crew?: WiredCrew
    mines?: WiredMines
    attention?: WiredAttention
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
          const sink = rollback.observedBatchSink(batches.sink)
          const observed = observationAdapters({
            folders,
            fs,
            clock,
            processes,
            openSnapshot: openReadOnlySnapshot
          })
          const observation = wireObservation({
            stores: createSqliteObservationStores({ db, scope: transactions, clock }),
            ...observed,
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
          const attention = servedAttention.wire({
            ledger: new SqliteAttentionLedger({
              db,
              scope: transactions,
              clock,
              hostEpoch: epoch as HostEpoch
            }),
            sink: rollback.level3Sink(new TransportLevel3Sink(connections), log),
            launcher: new AppBackgroundNotifierLauncher({
              processes,
              paths: new FakeAppPaths({ execPath: 'fake-install/DwarfAI-Miners' }),
              env: {},
              scheduler,
              onNotifierAttach: onNotifierAttach(connections)
            }),
            preferences: {
              get: () =>
                ({ systemNotificationsOn: true }) as ReturnType<
                  Parameters<typeof servedAttention.wire>[0]['preferences']['get']
                >
            },
            transactions,
            bus,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch as HostEpoch,
            log
          })
          // What host/main.ts does once every cut-1 module exists (16 §8.2 step 4).
          routeCut1Events({
            bus,
            observed: observed.adapters,
            sessions: observation.crew.sessions,
            conversation: conversation.conversation.commands,
            crew: crew.crew,
            mines: mines.mines.queries,
            attention: attention.attention
          })
          Object.assign(host, { conversation, observation, crew, mines, attention })
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
  const { conversation, observation, crew, mines, attention } = host
  if (
    conversation === undefined ||
    observation === undefined ||
    crew === undefined ||
    mines === undefined ||
    attention === undefined
  ) {
    throw new Error('boot step 4 wired no module')
  }
  onTestFinished(() => observation.observation.control.stop())

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
      capabilities: () =>
        collectCapabilities({
          methods: dispatcher.methods(),
          frames: [...CONVERSATION_READ_FRAMES, ...ATTENTION_FRAMES],
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
  const call = async (client: FrameClient, method: string, params: unknown) => {
    nextId += 1
    const id = `req-${nextId}`
    client.send({ type: 'req', id, method, params })
    await client.until(() => client.frames.some((frame) => isRes(frame, id)))
    return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
  }
  const settle = async (...clients: FrameClient[]) => {
    for (let round = 0; round < 5; round += 1) {
      await observation.idle()
      await crew.idle()
      await mines.idle()
      for (const client of clients) await client.settle()
      await tick()
    }
  }
  /** The `ui` and `notifier` clients, the `ui` reporting a visible window with no mine on screen. */
  const clients = async () => {
    const ui = await attach('ui')
    const notifier = await attach('notifier')
    const presence = await call(ui, 'presence', {
      onScreenMineIds: [],
      anyWindowVisible: true,
      seq: 1
    })
    expect(presence).toMatchObject({ ok: true })
    return { ui, notifier }
  }
  return {
    db: options.world.db,
    clock,
    published,
    conversation,
    crew,
    mines,
    attention,
    clients,
    settle,
    /** Declares the world's folder as a mine (S3.01) and lets its first walk run. */
    mine: async (cwd: FolderPath): Promise<MineId> => {
      const declared = await mines.mines.commands.declare(cwd)
      if (!declared.ok || !('mineId' in declared.value)) throw new Error('the mine was refused')
      clock.advance(DEFAULT_MINES_SETTINGS.automaticWalkDelayMs)
      await settle()
      return declared.value.mineId
    },
    /**
     * Polls of the live loop, then everything they caused. Each client pings first, as a UI does
     * every 5 s while idle, so its 15 s silence watch never detaches it (ADR-003 item 9).
     */
    poll: async (...pollClients: FrameClient[]) => {
      for (let n = 0; n < 3; n += 1) {
        await settle(...pollClients)
        for (const client of pollClients) await call(client, 'ping', {})
        clock.advance(OBSERVATION_POLL_MS)
        await settle(...pollClients)
      }
    },
    /** The dwarf the observed session `sessionId` arrived as. */
    dwarfOf: (sessionId: string): DwarfId => {
      const id = options.world.db.all(`SELECT id FROM dwarfs WHERE provider_session_id = ?`, [
        sessionId
      ])[0]?.['id']
      if (typeof id !== 'string') throw new Error(`no dwarf arrived for ${sessionId}`)
      return id as DwarfId
    },
    /** The `type` events the Host bus carried. */
    events: <T>(type: string): T[] =>
      published.flatMap((event) => (event.type === type ? [event.payload as T] : [])),
    stop: () => observation.observation.control.stop()
  }
}

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id?: string }).id === id
  )
}

/** The `name` frames `client` received, their data. */
function evts<T = unknown>(client: FrameClient, name: string): T[] {
  return client.frames.flatMap((frame) => {
    if ((frame as { type?: string }).type !== 'evt') return []
    const evt = evtFrameSchema.parse(frame)
    return evt.name === name ? [evt.data as T] : []
  })
}

type Notified = { key: string; kind: string; title: string; body: string; dwarfId: string }

function count(db: SqliteDatabase, sql: string, params: unknown[] = []): number {
  return Number(db.all(sql, params as never)[0]?.['n'])
}

const turnKey = (dwarfId: DwarfId, turn: string) => `${dwarfId}:turn-finished:${turn}`

describe('the cut-1 cross-epic routes (ISSUE-120)', () => {
  it("[ADR-007] a transcript entry an observer reads appears in the dwarf's conversation and as conversation.appended", async () => {
    const w = world()
    const h = await bootHost({ world: w, startAt: CODEX_T0 })
    await h.mine(w.cwd)
    const { ui } = await h.clients()

    w.write('turn-with-usage', CODEX_FIRST_TURN_OPEN)
    await h.poll(ui)

    const dwarfId = h.dwarfOf(CODEX_SESSION)
    expect(
      h.conversation.conversation.queries
        .feed(dwarfId)
        .messages.map((m) => [m.role, m.text])
        .reverse()
    ).toEqual([
      ['person', 'Count the files in this folder.'],
      ['dwarf', 'There are three files.']
    ])
    const appended = evts<{ dwarfId: string; messages: Array<{ text: string }> }>(
      ui,
      'conversation.appended'
    )
    expect(appended.flatMap((frame) => frame.messages.map((m) => m.text))).toEqual([
      'Count the files in this folder.',
      'There are three files.'
    ])
    expect(appended.every((frame) => frame.dwarfId === dwarfId)).toBe(true)
  })

  it('[S1.03, ADR-021] a reliable observed turn end moves the dwarf to idle and reaches attention once', async () => {
    const w = world()
    const h = await bootHost({ world: w, startAt: CODEX_T0 })
    await h.mine(w.cwd)
    const { ui, notifier } = await h.clients()

    w.write('turn-with-usage', CODEX_FIRST_TURN_OPEN)
    await h.poll(ui, notifier)
    const dwarfId = h.dwarfOf(CODEX_SESSION)
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('working')

    w.write('turn-with-usage', CODEX_FIRST_TURN_ENDED)
    await h.poll(ui, notifier)

    expect(h.events<{ end: { turnKey: string } }>('TurnEnded').map((e) => e.end.turnKey)).toEqual([
      CODEX_TURN_1
    ])
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('idle')
    expect(h.crew.crew.queries.get(dwarfId)?.facts.turn).toEqual({
      state: 'ended',
      endedAt: 1_790_762_405_300,
      reliability: 'reliable'
    })
    expect(evts<Notified>(notifier, 'attention.notify').map((n) => [n.key, n.kind])).toEqual([
      [turnKey(dwarfId, CODEX_TURN_1), 'turn-finished']
    ])
    expect(h.events<{ key: string }>('AttentionNotified').map((e) => e.key)).toEqual([
      turnKey(dwarfId, CODEX_TURN_1)
    ])
  })

  it('[S1.04, ADR-021] an inferred turn end moves the dwarf to idle and never reaches attention', async () => {
    const w = world()
    const h = await bootHost({ world: w, startAt: CLAUDE_T0 })
    await h.mine(w.cwd)
    const { ui, notifier } = await h.clients()

    w.write('turn-ends')
    await h.poll(ui, notifier)

    const dwarfId = h.dwarfOf(CLAUDE_SESSION)
    const ends = h.events<{ end: { reliability: string } }>('TurnEnded')
    expect(ends).toHaveLength(6)
    expect(ends.every((e) => e.end.reliability === 'inferred')).toBe(true)
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('idle')
    expect(h.crew.crew.queries.get(dwarfId)?.facts.turn).toEqual({
      state: 'ended',
      endedAt: 1_790_776_851_000,
      reliability: 'inferred'
    })
    expect(evts(notifier, 'attention.notify')).toEqual([])
    expect(h.events('AttentionNotified')).toEqual([])
    expect(count(h.db, `SELECT COUNT(*) AS n FROM attention_keys`)).toBe(0)
  })

  it('[US-SHELL-010.AC07, ADR-021] a turn end cancelled from the app never reaches attention', async () => {
    const w = world()
    const h = await bootHost({ world: w, startAt: CODEX_T0 })
    await h.mine(w.cwd)
    const { ui, notifier } = await h.clients()
    w.write('turn-with-usage', CODEX_FIRST_TURN_OPEN)
    await h.poll(ui, notifier)
    const dwarfId = h.dwarfOf(CODEX_SESSION)

    // A turn DwarfAI interrupted (Stop dwarf… mid-turn): reliable, but cancelled from the app.
    h.conversation.conversation.commands.recordTurnEnd({
      dwarfId,
      turnKey: CODEX_TURN_1,
      kind: 'interrupted',
      at: h.clock.now(),
      reliability: 'reliable',
      cancelledFromApp: true
    })
    await h.settle(ui, notifier)

    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('idle')
    expect(evts(notifier, 'attention.notify')).toEqual([])
    expect(h.events('AttentionNotified')).toEqual([])
  })

  it("[US-SHELL-010.AC09, INV-104] the notification for a reliable turn end carries the dwarf's custom name and the mine's name", async () => {
    const w = world()
    const h = await bootHost({ world: w, startAt: CODEX_T0 })
    const mineId = await h.mine(w.cwd)
    const { ui, notifier } = await h.clients()
    w.write('turn-with-usage', CODEX_FIRST_TURN_OPEN)
    await h.poll(ui, notifier)
    const dwarfId = h.dwarfOf(CODEX_SESSION)
    // The person renamed the dwarf (US-MSG-005): the custom name is what a title shows.
    w.db.run(`UPDATE dwarfs SET custom_name = 'Thorin' WHERE id = ?`, [dwarfId])

    w.write('turn-with-usage', CODEX_FIRST_TURN_ENDED)
    await h.poll(ui, notifier)

    const [notified] = evts<Notified>(notifier, 'attention.notify')
    expect(notified?.title).toContain('Thorin')
    expect(notified?.title).not.toContain(h.crew.crew.queries.get(dwarfId)?.baseName)
    expect(notified?.body).toBe(h.mines.mines.queries.get(mineId)?.name)
    expect(notified?.body).toBe('moria')
  })

  it('[S17.05] the finished-turn notification is withdrawn when the dwarf starts its next turn or departs', async () => {
    const w = world()
    const h = await bootHost({ world: w, startAt: CODEX_T0 })
    await h.mine(w.cwd)
    const { ui, notifier } = await h.clients()
    w.write('turn-with-usage', CODEX_FIRST_TURN_ENDED)
    await h.poll(ui, notifier)
    const dwarfId = h.dwarfOf(CODEX_SESSION)
    expect(evts(notifier, 'attention.withdraw')).toEqual([])

    // The next turn starts: the first turn's notification is withdrawn.
    w.write('turn-with-usage', CODEX_SECOND_TURN_STARTED)
    await h.poll(ui, notifier)
    expect(evts(notifier, 'attention.withdraw')).toEqual([
      { keys: [turnKey(dwarfId, CODEX_TURN_1)] }
    ])

    // The second turn ends and the dwarf departs: the second turn's notification is withdrawn.
    w.write('turn-with-usage')
    await h.poll(ui, notifier)
    h.crew.crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
    await h.settle(ui, notifier)

    expect(evts<Notified>(notifier, 'attention.notify').map((n) => n.key)).toEqual([
      turnKey(dwarfId, CODEX_TURN_1),
      turnKey(dwarfId, CODEX_TURN_2)
    ])
    expect(evts(notifier, 'attention.withdraw')).toEqual([
      { keys: [turnKey(dwarfId, CODEX_TURN_1)] },
      { keys: [turnKey(dwarfId, CODEX_TURN_2)] }
    ])
  })

  it('[US-SHELL-010.AC06] a departure withdraws every attention key of that dwarf', async () => {
    const w = world()
    const h = await bootHost({ world: w, startAt: CODEX_T0 })
    await h.mine(w.cwd)
    const { ui, notifier } = await h.clients()
    w.write('turn-with-usage', CODEX_FIRST_TURN_ENDED)
    w.write('turn-aborted')
    await h.poll(ui, notifier)
    const dwarfId = h.dwarfOf(CODEX_SESSION)
    const other = h.dwarfOf(ABORTED_SESSION)
    const standing = [turnKey(dwarfId, CODEX_TURN_1), turnKey(other, ABORTED_TURN_2)]
    expect(h.events<{ key: string }>('AttentionNotified').map((e) => e.key)).toEqual(
      expect.arrayContaining(standing)
    )
    const withdrawnBefore = evts(notifier, 'attention.withdraw').length

    h.crew.crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
    await h.settle(ui, notifier)

    expect(evts(notifier, 'attention.withdraw').slice(withdrawnBefore)).toEqual([
      { keys: [turnKey(dwarfId, CODEX_TURN_1)] }
    ])
    // The other dwarf's key stands.
    expect(
      count(
        h.db,
        `SELECT COUNT(*) AS n FROM attention_keys WHERE key = ? AND withdrawn_at IS NULL`,
        [turnKey(other, ABORTED_TURN_2)]
      )
    ).toBe(1)
  })

  it('[ADR-006] replaying the same fixture batch after a simulated restart produces no second message, turn end or notification', async () => {
    const w = world()
    const first = await bootHost({ world: w, startAt: CODEX_T0 })
    await first.mine(w.cwd)
    const one = await first.clients()
    w.write('turn-with-usage', CODEX_FIRST_TURN_ENDED)
    await first.poll(one.ui, one.notifier)
    const dwarfId = first.dwarfOf(CODEX_SESSION)
    expect(evts(one.notifier, 'attention.notify')).toHaveLength(1)
    first.stop()
    const messages = count(w.db, `SELECT COUNT(*) AS n FROM messages WHERE dwarf_id = ?`, [dwarfId])
    const turnFacts = `SELECT COUNT(*) AS n FROM dwarf_lifecycle_facts WHERE type = 'TurnEnded'`
    expect(messages).toBe(2)
    expect(count(w.db, turnFacts)).toBe(1)

    // A new Host over the same rows whose cursors were lost: the whole batch is read again.
    w.db.exec(`DELETE FROM source_cursors`)
    const second = await bootHost({ world: w, startAt: (CODEX_T0 + 60_000) as Instant })
    const two = await second.clients()
    await second.poll(two.ui, two.notifier)

    expect(count(w.db, `SELECT COUNT(*) AS n FROM messages WHERE dwarf_id = ?`, [dwarfId])).toBe(
      messages
    )
    expect(count(w.db, turnFacts)).toBe(1)
    expect(second.events('MessagesAppended')).toEqual([])
    expect(second.events('TurnEnded')).toEqual([])
    expect(second.events('AttentionNotified')).toEqual([])
    expect(evts(two.notifier, 'attention.notify')).toEqual([])
    expect(evts(two.ui, 'conversation.appended')).toEqual([])
  })

  it("[FM-137, ADR-006] an observed batch's messages are written in the cursor's transaction, and a failure while writing them leaves the cursor where it was", async () => {
    const w = world()
    const h = await bootHost({ world: w, startAt: CODEX_T0 })
    await h.mine(w.cwd)
    const { ui } = await h.clients()
    w.write('turn-with-usage', 1)
    await h.poll(ui)
    const dwarfId = h.dwarfOf(CODEX_SESSION)
    const cursors = () => w.db.all(`SELECT * FROM source_cursors ORDER BY stream_id`)
    const before = cursors()

    // Writing a message fails: the batch's transaction rolls back with its cursor advance.
    w.db.exec(`CREATE TEMP TRIGGER refuse_messages BEFORE INSERT ON messages
               BEGIN SELECT RAISE(ABORT, 'the message log is full'); END`)
    w.write('turn-with-usage', CODEX_FIRST_TURN_OPEN)
    await h.poll(ui)
    expect(cursors()).toEqual(before)
    expect(count(w.db, `SELECT COUNT(*) AS n FROM messages WHERE dwarf_id = ?`, [dwarfId])).toBe(0)
    expect(evts(ui, 'conversation.appended')).toEqual([])

    // Once writing works again the same batch is read from the old position, once.
    w.db.exec(`DROP TRIGGER refuse_messages`)
    await h.poll(ui)
    expect(count(w.db, `SELECT COUNT(*) AS n FROM messages WHERE dwarf_id = ?`, [dwarfId])).toBe(2)
    expect(cursors()).not.toEqual(before)
  })

  it("[S11.05, US-MSG-014.AC03] a departure closes the dwarf's open activity run", async () => {
    const w = world()
    const h = await bootHost({ world: w, startAt: CLAUDE_T0 })
    await h.mine(w.cwd)
    const { ui } = await h.clients()
    w.write('turn-ends', 1)
    await h.poll(ui)
    const dwarfId = h.dwarfOf(CLAUDE_SESSION)
    // No observer yields tool steps yet (15 §1.2 `ActivityStep`): the dwarf's step reaches its run
    // through conversation's own command, as a driver stream's will (EPIC-10).
    h.conversation.conversation.commands.ingest(
      dwarfId,
      [
        {
          sourceKey: 'claude:session-120:event-1',
          role: 'dwarf',
          text: 'Reading the folder.',
          providerTime: h.clock.now(),
          activity: [
            {
              sourceKey: 'claude:session-120:tool-1',
              turnKey: 'turn-1',
              kind: 'tool',
              toolName: 'Read',
              summary: 'Read main.ts',
              state: 'finished',
              at: h.clock.now()
            }
          ]
        }
      ],
      'transcript'
    )
    await h.settle(ui)
    expect(h.events<{ dwarfId: string; open: boolean }>('ActivityChanged').at(-1)).toMatchObject({
      dwarfId,
      open: true
    })

    h.crew.crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
    await h.settle(ui)

    expect(h.events<{ dwarfId: string; open: boolean }>('ActivityChanged').at(-1)).toMatchObject({
      dwarfId,
      open: false
    })
    expect(evts<{ open: boolean }>(ui, 'activity.changed').at(-1)).toMatchObject({ open: false })
  })
})
