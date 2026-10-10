// layer: L2
// L2 flow (17 §1.2; 05 §4; 08 §2.7, §7.2; 16 §8.2, §8.3; ADR-010 items 1, 6, 11; ADR-018 items 2–3;
// ADR-016): the asking module wired into the Host (host/wiring/routes/askingRoutes.ts, ISSUE-140)
// over the composition host/main.ts builds: the members served before the bind, preferences at
// boot step 3 with the real config writer engine and its Claude Code hooks target over a FakeFs,
// then at step 4 suppliers, the ledger, conversation, the `ObservedBatchSink` bridge, observation
// over the real provider adapters, crew, mines, attention, asking and the cut-1 routes; step 7
// starts observation.
//
// The real boot step list, the Host dispatcher and connection registry behind in-process duplexes,
// one `ui` and one `notifier` client (frames validated against their contract schemas; no OS
// notification is ever drawn), one copy of the template database, a FakeClock, FakeScheduler and
// FakeProcessControl. The observed Claude session is the recorded fixture
// `fixtures/claude/hook-keystroke/2.1.x/pending-permission.jsonl` (synthetic, scrubbed), laid out in
// a per-test temp home folder in its real spelling, its working folder rewritten to a temp folder
// declared as a mine (17 §5.3). Claude Code's hook requests reach the `/hooks/claude/*` route the
// wiring builds, in process: the listener and its port are boot step 6's (later: ISSUE-209), so
// where a case needs Claude Code instant updates on it persists the port as that listener will.
// The keystroke relay is the FakeKeystrokeRelay (the real one is later: ISSUE-167). No test reads
// the person's home folder or a provider credential (AGENTS §6).
//
// TC-140-01 … TC-140-04.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
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
  redactSecrets,
  resFrameSchema
} from '@dwarfai/contracts'
import type { DomainEvent } from '../../kernel/domain/domainEvent'
import type {
  AskId,
  DwarfId,
  EventId,
  FolderPath,
  HostEpoch,
  Instant,
  MineId,
  ProviderId
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
import type { AskingEvent, AskRecord } from '../../modules/asking'
import { FsTranscriptTail } from '../../modules/asking/adapters/observedClaude/transcriptTail'
import { toolResultLine } from '../../modules/asking/testing/claudeTranscript'
import { FakeKeystrokeRelay } from '../../modules/asking/testing/FakeKeystrokeRelay'
import { AppBackgroundNotifierLauncher } from '../../modules/attention/adapters/AppBackgroundNotifierLauncher'
import { SqliteAttentionLedger } from '../../modules/attention/adapters/SqliteAttentionLedger'
import { ProviderHistoryScanner } from '../../modules/ledger/adapters/ProviderHistoryScanner'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
import { createHostGitRepoInspector } from '../../modules/mines/adapters/FsGitRepoInspector'
import { FsSourceWeightScanner } from '../../modules/mines/adapters/FsSourceWeightScanner'
import { OBSERVATION_POLL_MS, createSqliteObservationStores } from '../../modules/observation'
import type { PreferencesEvent } from '../../modules/preferences'
import { ClaudeHooksConfigWriter } from '../../modules/preferences/adapters/external-config/claudeHooks/ClaudeHooksConfigWriter'
import { ConfigWriterEngine } from '../../modules/preferences/adapters/external-config/configWriterEngine'
import { SqliteChannelTokenStore } from '../../modules/preferences/adapters/sqlite/SqliteChannelTokenStore'
import { SqliteConfigWriteLedger } from '../../modules/preferences/adapters/sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from '../../modules/preferences/adapters/sqlite/SqliteIntegrationSettingStore'
import type { InstallResolver, SuppliersEvent } from '../../modules/suppliers'
import { SqliteCapabilityRecordStore } from '../../modules/suppliers/adapters/sqlite/SqliteCapabilityRecordStore'
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
import { INGRESS_TOKEN_HEADER } from '../../transport/ingress/httpIngress'
import { createUpgradeDrain } from '../../transport/lifecycle/drain'
import { HostStateHolder } from '../../transport/lifecycle/hostState'
import { createUpgradeTargetRule } from '../../transport/methods/hostUpgradeRequest'
import { PREFERENCES_FRAMES } from '../../transport/methods/preferences'
import { SET_CLAUDE_HOOKS_FRAMES } from '../../transport/methods/setClaudeHooks'
import { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { FrameClient } from '../../transport/testing/frameClient'
import { inProcessDuplex } from '../../transport/testing/inProcessDuplex'
import { runBoot, type BootOutcome } from '../boot'
import { createBootSteps, mintBootEpoch } from '../bootSteps'
import { hostConfigWriter, persistedIngressPort } from '../bridges/hostConfigWriter'
import { appMetaIngressPort } from '../bridges/ingressPort'
import { composeObservedBatchSink } from '../bridges/observedBatchSink'
import { cut1RollbackChoices } from '../cut1Rollback'
import { emptyDrainGate } from '../emptyDrainGate'
import { createHostDispatcher } from '../hostDispatcher'
import { createModuleResetSteps } from '../moduleResetSteps'
import {
  servePreferences,
  unavailableSecretStore,
  type WiredPreferences
} from '../preferencesWiring'
import {
  ASKING_FRAMES,
  serveAsking,
  type AskingRouteEvent,
  type AskingWiringDeps,
  type WiredAsking
} from '../routes/askingRoutes'
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
import { wireSuppliers } from '../suppliersWiring'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures')
/** pending-permission.jsonl: an observed Claude session whose last record is a pending Bash call. */
const PENDING_PERMISSION = join(FIXTURES, 'claude/hook-keystroke/2.1.x/pending-permission.jsonl')
const FIXTURE_CWD = 'C:\\Users\\j\\work\\sample.project'
const SESSION = '01a0b000-0000-7000-8000-000000001341'
const CALL = 'toolu_01KeystrokeBash'
/** The fixture's first record is 2026-09-30T10:00:01Z; the Host starts just before it. */
const T0 = 1_790_762_398_000 as Instant
/** Before every record of the fixture. */
const INSTALL_BEFORE_ALL = 1_790_700_000_000 as Instant
/** The port the hook ingress persists when it first binds (ADR-016 item 3; later: ISSUE-209). */
const INGRESS_PORT = 41_234
/** Claude Code's settings file on the FakeFs (`CLAUDE_CONFIG_DIR` unset: `~/.claude`, 16 §7.1). */
const CLAUDE_SETTINGS = '/home/person/.claude/settings.json'
const CLAUDE = 'claude' as ProviderId

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

/** Claude Code installed: `claude` resolves on the PATH (inline double, R15). */
const claudeInstalled: InstallResolver = {
  resolve: (binaries) =>
    Promise.resolve(
      binaries.includes('claude')
        ? { path: '/opt/tools/claude', version: '2.1.263', resolvedVia: 'path' as const }
        : null
    )
}

/** A temp root: a home folder with Claude's folders, the mine's folder and the Host database. */
function world() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-140-asking-')))
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
  const project = join(folders.claudeConfigDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  const transcriptPath = join(project, `${SESSION}.jsonl`)
  // Claude Code's own folder on the disk the config writer writes (16 §7.1).
  const disk = new FakeFs()
  void disk.makeDir('/home/person/.claude')
  return {
    root,
    folders,
    cwd: cwd as FolderPath,
    db,
    disk,
    transcriptPath,
    processes: new FakeProcessControl({ bootId: 'boot-a' }),
    /** Claude Code writes the fixture session up to its pending Bash call. */
    writeSession: () =>
      writeFileSync(
        transcriptPath,
        jsonPathSwap(readFileSync(PENDING_PERMISSION, 'utf8'), FIXTURE_CWD, cwd)
      ),
    /** The person answers the dialog in the terminal: the call's result lands in the transcript. */
    resolveInTerminal: () => appendFileSync(transcriptPath, `${toolResultLine(CALL, '2.1.263')}\n`)
  }
}
type World = ReturnType<typeof world>

type HostBusEvent =
  | PreferencesEvent
  | SuppliersEvent
  | MinesRouteEvent
  | CrewRouteEvent
  | LedgerRouteEvent
  | ConversationRouteEvent
  | AttentionRouteEvent
  | AskingRouteEvent

/** One Host start over `world`, composed as host/main.ts composes it. */
async function bootHost(w: World) {
  const { db, processes, folders } = w
  const rollback = cut1RollbackChoices(false)
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
  const servedPreferences = servePreferences({ dispatcher, sections, connections })
  const servedMines = serveMines({ dispatcher, sections, connections })
  const servedCrew = serveCrew({ dispatcher, sections })
  const servedConversation = serveConversation({ dispatcher, sections })
  const servedAsking = serveAsking({ dispatcher, sections })
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
  const relay = new FakeKeystrokeRelay()
  const host: {
    preferences?: WiredPreferences
    conversation?: WiredConversation
    observation?: WiredObservation
    crew?: WiredCrew
    mines?: WiredMines
    attention?: WiredAttention
    asking?: WiredAsking
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
        // Step 3, as host/main.ts wires cut 2: the config writer with the Claude Code hooks target
        // and the channel-token lookup the hook ingress reads.
        resumeResetSaga: () => {
          const ingressPort = appMetaIngressPort(db)
          const engine = new ConfigWriterEngine({
            fs: w.disk,
            transactions,
            ledger: new SqliteConfigWriteLedger({ db }),
            settings: new SqliteIntegrationSettingStore({ db }),
            tokens: new SqliteChannelTokenStore({ db, ids }),
            clock,
            ids,
            scheduler,
            log,
            targets: [
              new ClaudeHooksConfigWriter({
                path: CLAUDE_SETTINGS,
                platform: 'linux',
                ingressPort: persistedIngressPort(ingressPort)
              })
            ]
          })
          host.preferences = servedPreferences.wire({
            db,
            transactions,
            bus,
            clock,
            ids,
            hostEpoch: epoch as HostEpoch,
            log,
            featureFlags: { read: () => ({ guildAreasEnabled: false, boostEnabled: false }) },
            maintenance: {
              deleteBackups: () => undefined,
              truncateWal: () => undefined,
              vacuum: () => undefined
            },
            ledger: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
            moduleSteps: createModuleResetSteps({
              db,
              scope: transactions,
              clock,
              mapSites: [],
              random: () => 0
            }).steps,
            secrets: unavailableSecretStore,
            externalConfig: hostConfigWriter({ claudeHooks: engine, ingressPort, log }),
            channelTokens: new SqliteChannelTokenStore({ db, ids }),
            ready: () => state.current().state === 'ready'
          })
          return host.preferences.resumeOnBoot()
        },
        constructModules: () => {
          const preferences = host.preferences
          if (preferences === undefined) throw new Error('step 4 runs after step 3')
          const suppliers = wireSuppliers({
            publicBuild: false,
            clock,
            scheduler,
            ids,
            fs: w.disk,
            log,
            installResolver: claudeInstalled,
            capabilityRecords: new SqliteCapabilityRecordStore({
              db,
              tx: transactions,
              ids,
              log
            }),
            integrationGate: preferences.integrationGate,
            bus,
            hostEpoch: epoch as HostEpoch,
            simulatedSeed: epoch
          })
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
            sink: rollback.observedBatchSink(batches.sink),
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
            preferences: preferences.preferences.queries,
            transactions,
            bus,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch as HostEpoch,
            log
          })
          // What host/main.ts does: asking, then the cut-1 routes (16 §8.2 step 4).
          // A typed constant, not an inline literal: TypeScript 6.0.3 crashes checking that call.
          const askingDeps: AskingWiringDeps = {
            db,
            transactions,
            bus,
            sources: { departures: bus, resolutions: bus },
            clock,
            scheduler,
            ids,
            hostEpoch: epoch as HostEpoch,
            log,
            frames: connections,
            claudeProviderId: CLAUDE,
            suppliers,
            observed: observed.adapters,
            conversation: conversation.conversation,
            crew: crew.crew,
            mines: mines.mines.queries,
            attention: attention.attention,
            observation: { sessions: observation.crew.sessions, control: observation },
            preferences: {
              queries: preferences.preferences.queries,
              channelTokens: preferences.channelTokens
            },
            keystrokes: { relay, transcripts: new FsTranscriptTail(fs), redact: redactSecrets }
          }
          const asking = servedAsking.wire(askingDeps)
          routeCut1Events({
            bus,
            observed: observed.adapters,
            sessions: observation.crew.sessions,
            conversation: conversation.conversation.commands,
            crew: crew.crew,
            mines: mines.mines.queries,
            attention: attention.attention
          })
          Object.assign(host, { conversation, observation, crew, mines, attention, asking })
        },
        startObservation: () => host.observation?.start?.(),
        startModules: () => host.mines?.start()
      }),
    {
      log,
      clock,
      state,
      privilege: () =>
        Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
      paths: { ok: true, value: new FakeAppPaths({ userDataDir: w.root }) },
      runtime: { os: 'win32', arch: 'x64', node: '24.18.1' },
      exit: () => undefined
    }
  )
  expect(await boot).toEqual({ kind: 'ready' })
  const { conversation, observation, crew, mines, attention, asking } = host
  if (
    conversation === undefined ||
    observation === undefined ||
    crew === undefined ||
    mines === undefined ||
    attention === undefined ||
    asking === undefined
  ) {
    throw new Error('boot step 4 wired no module')
  }
  onTestFinished(() => observation.observation.control.stop())

  const token = new UiToken()
  await token.issue(join(w.root, 'run'))
  const secret = readFileSync(join(w.root, 'run', UI_TOKEN_FILE), 'utf8')
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
      // The frame list host/main.ts hands the endpoint, for the modules composed here.
      capabilities: () =>
        collectCapabilities({
          methods: dispatcher.methods(),
          frames: [
            ...PREFERENCES_FRAMES,
            ...SET_CLAUDE_HOOKS_FRAMES,
            ...CONVERSATION_READ_FRAMES,
            ...ATTENTION_FRAMES,
            ...ASKING_FRAMES
          ],
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
  let nextRid = 0
  /** A fresh requestId for each mutating request (14 §1.6). */
  const rid = (): string => {
    nextRid += 1
    return `01890a5d-ac96-774b-bcce-b30214${String(nextRid).padStart(6, '0')}`
  }
  const settle = async (...clients: FrameClient[]) => {
    for (let round = 0; round < 5; round += 1) {
      await observation.idle()
      await crew.idle()
      await mines.idle()
      await asking.evidence.idle()
      for (const client of clients) await client.settle()
      await tick()
    }
  }
  /** Polls of the live loop, then everything they caused; each client pings to stay attached. */
  const poll = async (...pollClients: FrameClient[]) => {
    for (let n = 0; n < 3; n += 1) {
      await settle(...pollClients)
      for (const client of pollClients) await call(client, 'ping', {})
      clock.advance(OBSERVATION_POLL_MS)
      await settle(...pollClients)
    }
  }
  const decoder = new TextDecoder()
  return {
    clock,
    log,
    published,
    relay,
    conversation,
    crew,
    mines,
    attention,
    asking,
    attach,
    call,
    rid,
    settle,
    poll,
    /** The `ui` and `notifier` clients, the `ui` reporting a visible window with no mine on screen. */
    clients: async () => {
      const ui = await attach('ui')
      const notifier = await attach('notifier')
      const presence = await call(ui, 'presence', {
        onScreenMineIds: [],
        anyWindowVisible: true,
        seq: 1
      })
      expect(presence).toMatchObject({ ok: true })
      return { ui, notifier }
    },
    /** Declares the world's folder as a mine (S3.01) and lets its first walk run. */
    mine: async (): Promise<MineId> => {
      const declared = await mines.mines.commands.declare(w.cwd)
      if (!declared.ok || !('mineId' in declared.value)) throw new Error('the mine was refused')
      clock.advance(DEFAULT_MINES_SETTINGS.automaticWalkDelayMs)
      await settle()
      return declared.value.mineId
    },
    /**
     * Claude Code instant updates turned on over `ui` (B-M39), once the hook ingress persisted its
     * port as its listener will (later: ISSUE-209); the plaintext token of the hook entry written.
     */
    instantUpdatesOn: async (ui: FrameClient): Promise<string> => {
      appMetaIngressPort(db).write(INGRESS_PORT)
      const answered = await call(ui, 'preferences.setClaudeHooks', { on: true, requestId: rid() })
      expect(answered).toMatchObject({ ok: true, result: { ok: true } })
      const read = await w.disk.readFile(CLAUDE_SETTINGS)
      const text = read.ok ? decoder.decode(read.value) : ''
      const tokens = [...new Set(text.match(/[0-9a-f]{64}/g) ?? [])]
      expect(tokens).toHaveLength(1)
      return tokens[0] ?? ''
    },
    /**
     * One Claude Code hook request at `/hooks/claude/*` as the ingress hands it to its route: the
     * admission by the presented token (401 otherwise), then the body's delivery after the answer.
     */
    hook: async (token: string, body: Record<string, unknown>): Promise<204 | 401 | 400> => {
      const route = asking.hookRoutes.find((r) => r.prefix === '/hooks/claude/')
      if (route === undefined) throw new Error('no Claude hook route was wired')
      if (!route.admits(token)) return 401
      const deliver = route.accept(JSON.stringify(body))
      if (deliver === null) return 400
      deliver()
      await settle()
      return 204
    },
    /** The dwarf the observed session arrived as. */
    dwarfOf: (): DwarfId => {
      const id = db.all(`SELECT id FROM dwarfs WHERE provider_session_id = ?`, [SESSION])[0]?.['id']
      if (typeof id !== 'string') throw new Error(`no dwarf arrived for ${SESSION}`)
      return id as DwarfId
    },
    /** The `type` events the Host bus carried. */
    events: <T>(type: string): T[] =>
      published.flatMap((event) => (event.type === type ? [event.payload as T] : [])),
    /** Publishes an asking event on the Host bus as the broker does, after its commit. */
    publishAsking: (event: Pick<AskingEvent, 'type' | 'payload'>) => {
      nextId += 1
      bus.publish({
        ...event,
        v: 1,
        id: `00000000-0000-7000-8000-${String(nextId).padStart(12, '0')}` as EventId,
        at: clock.now(),
        hostEpoch: epoch as HostEpoch
      } as AskingEvent)
    },
    db
  }
}
type Host = Awaited<ReturnType<typeof bootHost>>

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

/** Claude Code's hook body for its permission dialog on the fixture session (ADR-012 item 6). */
function permissionRequest(w: World): Record<string, unknown> {
  return {
    hook_event_name: 'PermissionRequest',
    session_id: SESSION,
    transcript_path: w.transcriptPath,
    tool_name: 'Bash'
  }
}

/**
 * A booted Host with the fixture session's dwarf present in its mine, Claude Code instant updates
 * on, and the `ui` and `notifier` clients attached.
 */
async function observedClaude() {
  const w = world()
  const h = await bootHost(w)
  const mineId = await h.mine()
  const { ui, notifier } = await h.clients()
  const token = await h.instantUpdatesOn(ui)
  w.writeSession()
  await h.poll(ui, notifier)
  const dwarfId = h.dwarfOf()
  return { w, h, mineId, ui, notifier, token, dwarfId }
}

/** The fixture's ask, as the broker stored it. */
function askOf(h: Host, dwarfId: DwarfId): AskRecord | null {
  return h.asking.queries.openAskOf(dwarfId)
}

describe('the asking module wired into the Host (ISSUE-140)', () => {
  it('[ADR-010] an observed Claude permission opens one ask, the dwarf becomes asking, the ui receives ask.opened and the notifier receives one notification when its mine is not on screen', async () => {
    const { w, h, mineId, ui, notifier, token, dwarfId } = await observedClaude()
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('working')

    expect(await h.hook(token, permissionRequest(w))).toBe(204)
    await h.settle(ui, notifier)

    const ask = askOf(h, dwarfId)
    expect(ask).toMatchObject({
      dwarfId,
      kind: 'permission',
      channel: 'hook-keystroke',
      providerRequestId: CALL,
      state: 'open',
      reannounce: true
    })
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('asking')
    expect(evts<{ ask: { id: string } }>(ui, 'ask.opened').map((f) => f.ask.id)).toEqual([ask?.id])
    expect(evts<{ key: string; kind: string }>(notifier, 'attention.notify')).toEqual([
      expect.objectContaining({ key: `${dwarfId}:permission:${ask?.id}`, kind: 'permission' })
    ])
    // The ask joins the snapshot's `asks` section and the needs-you queue.
    expect(h.asking.queries.snapshot()).toMatchObject({
      asks: [expect.objectContaining({ id: ask?.id })],
      needsYou: [expect.objectContaining({ dwarfId, mineId })]
    })
  })

  it('[ADR-010] answering it in the app presses the key, closes the ask answered-in-app, withdraws the notification and the dwarf leaves asking', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    const ask = askOf(h, dwarfId)
    if (ask === null) throw new Error('no ask opened')

    const answered = await h.call(ui, 'asking.answerPermission', {
      askId: ask.id,
      decision: 'allow',
      requestId: h.rid()
    })
    await h.settle(ui, notifier)

    expect(answered).toMatchObject({ ok: true, result: { kind: 'accepted' } })
    expect(h.relay.pressed.map((p) => p.key)).toEqual([{ kind: 'text', text: '1' }])
    expect(h.events<{ askId: string; reason: string }>('AskClosed')).toEqual([
      expect.objectContaining({ askId: ask.id, reason: 'answered-in-app' })
    ])
    expect(evts(ui, 'ask.closed')).toEqual([{ askId: ask.id, dwarfId, reason: 'answered-in-app' }])
    expect(evts<{ keys: string[] }>(notifier, 'attention.withdraw')).toEqual([
      expect.objectContaining({ keys: [`${dwarfId}:permission:${ask.id}`] })
    ])
    // S1.13: its turn is still active, so the dwarf is working again.
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('working')
  })

  it('[S6.11] answering it in the terminal closes the ask answered-elsewhere with no notice and withdraws the notification', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    const ask = askOf(h, dwarfId)
    if (ask === null) throw new Error('no ask opened')
    const framesBefore = ui.frames.length

    w.resolveInTerminal()
    await h.hook(token, { hook_event_name: 'PostToolUse', session_id: SESSION, tool_name: 'Bash' })
    await h.settle(ui, notifier)

    expect(h.asking.queries.openAskOf(dwarfId)).toBeNull()
    expect(evts(ui, 'ask.closed')).toEqual([
      { askId: ask.id, dwarfId, reason: 'answered-elsewhere' }
    ])
    // No notice: no toast and nothing pressed.
    expect(evts(ui, 'toast')).toEqual([])
    expect(h.relay.pressed).toEqual([])
    expect(evts<{ keys: string[] }>(notifier, 'attention.withdraw')).toEqual([
      expect.objectContaining({ keys: [`${dwarfId}:permission:${ask.id}`] })
    ])
    expect(ui.frames.length).toBeGreaterThan(framesBefore)
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('working')
  })

  it('[S6.14, INV-77] the dwarf departing closes its open asks closed-by-death', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    const ask = askOf(h, dwarfId)
    if (ask === null) throw new Error('no ask opened')
    const asking = h.conversation.conversation.queries.outcomeOf(dwarfId)

    h.crew.crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
    await h.settle(ui, notifier)

    expect(h.asking.queries.openAskOf(dwarfId)).toBeNull()
    expect(h.events<{ askId: string; reason: string }>('AskClosed')).toEqual([
      expect.objectContaining({ askId: ask.id, reason: 'closed-by-death' })
    ])
    expect(evts(ui, 'ask.closed')).toEqual([{ askId: ask.id, dwarfId, reason: 'closed-by-death' }])
    expect(
      evts<{ keys: string[] }>(notifier, 'attention.withdraw').flatMap((f) => f.keys)
    ).toContain(`${dwarfId}:permission:${ask.id}`)
    // The outcome line no longer says the dwarf waits on the person (noteAsk closed).
    expect(asking?.kind).toBe('waiting-on-you')
    expect(h.conversation.conversation.queries.outcomeOf(dwarfId)?.kind).not.toBe('waiting-on-you')
  })

  it('[INV-103] a re-raised ask with reannounce false opens with no notification', async () => {
    const { h, ui, notifier, dwarfId } = await observedClaude()
    // A re-raise after a silent resume (07 S6.19) reaches the Host with EPIC-10's driver resume; its
    // record is the broker's, stored and then announced with `reannounce: false`.
    const askId = '00000000-0000-7000-8000-000000140aa1' as AskId
    const reraised = {
      id: askId,
      dwarfId,
      kind: 'permission' as const,
      channel: 'driver' as const,
      providerRequestId: 'request-reraised',
      payload: { toolName: 'Bash', requestText: 'pnpm test' },
      currentStep: 0,
      state: 'open' as const,
      reannounce: false,
      openedAt: h.clock.now()
    }
    h.db.run(
      `INSERT INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json, state,
         reannounce, opened_at)
       VALUES (?, ?, 'permission', 'driver', ?, ?, 'open', 0, ?)`,
      [askId, dwarfId, reraised.providerRequestId, JSON.stringify(reraised.payload), h.clock.now()]
    )

    h.publishAsking({ type: 'AskOpened', payload: { ask: reraised } } as never)
    await h.settle(ui, notifier)

    expect(evts<{ ask: { id: string } }>(ui, 'ask.opened').map((f) => f.ask.id)).toEqual([askId])
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('asking')
    expect(evts(notifier, 'attention.notify')).toEqual([])
  })

  it('[ADR-003] hello.ok advertises the asking methods, section:asks and the ask frames', async () => {
    const h = await bootHost(world())

    const ui = await h.attach('ui')

    const capabilities = (ui.frames[0] as { capabilities: readonly string[] }).capabilities
    expect(capabilities).toEqual(
      expect.arrayContaining([
        methodCapability('asking.answerQuestion'),
        methodCapability('asking.answerPermission'),
        methodCapability('asking.setStep'),
        'section:asks',
        frameCapability('ask.opened'),
        frameCapability('ask.closed'),
        frameCapability('ask.step')
      ])
    )
  })

  it('[ADR-010] the same observed ask evidence twice opens one ask', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()

    await h.hook(token, permissionRequest(w))
    await h.hook(token, permissionRequest(w))
    await h.hook(token, {
      hook_event_name: 'Notification',
      session_id: SESSION,
      notification_type: 'permission_prompt'
    })
    await h.settle(ui, notifier)

    expect(h.events('AskOpened')).toHaveLength(1)
    expect(evts(ui, 'ask.opened')).toHaveLength(1)
    expect(evts(notifier, 'attention.notify')).toHaveLength(1)
    expect(h.asking.queries.openAsks().filter((a) => a.dwarfId === dwarfId)).toHaveLength(1)
  })

  it('[ADR-016] turning Claude Code instant updates on makes the hook ingress accept a request with the new token', async () => {
    const w = world()
    const h = await bootHost(w)
    const ui = await h.attach('ui')
    const body = { hook_event_name: 'Stop', session_id: SESSION }
    // Off: the ingress refuses every request (ADR-012 item 6).
    expect(await h.hook('a'.repeat(64), body)).toBe(401)

    const token = await h.instantUpdatesOn(ui)

    expect(await h.hook(token, body)).toBe(204)
    expect(INGRESS_TOKEN_HEADER).toBe('x-dwarfai-token')
    // NFR-SEC-12: neither the token nor its hash reaches a log record.
    expect(JSON.stringify(h.log.entries)).not.toContain(token)
  })

  it('[ADR-016] a request at the hook ingress with the previous token is refused once the token rotated', async () => {
    const w = world()
    const h = await bootHost(w)
    const ui = await h.attach('ui')
    const body = { hook_event_name: 'Stop', session_id: SESSION }
    const previous = await h.instantUpdatesOn(ui)
    const off = await h.call(ui, 'preferences.setClaudeHooks', { on: false, requestId: h.rid() })
    expect(off).toMatchObject({ ok: true, result: { ok: true } })

    const next = await h.instantUpdatesOn(ui)

    expect(next).not.toBe(previous)
    expect(await h.hook(previous, body)).toBe(401)
    expect(await h.hook(next, body)).toBe(204)
  })

  it('[S1.16] an auto-denied ask leaves the dwarf status and its outcome line unchanged', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    const outcome = h.conversation.conversation.queries.outcomeOf(dwarfId)
    const statusChanges = h.events('DwarfStatusChanged').length

    h.publishAsking({
      type: 'AskClosed',
      payload: {
        askId: '00000000-0000-7000-8000-000000140ad1' as AskId,
        dwarfId,
        reason: 'auto-denied'
      }
    } as never)
    await h.settle(ui, notifier)

    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('asking')
    expect(h.events('DwarfStatusChanged')).toHaveLength(statusChanges)
    expect(h.conversation.conversation.queries.outcomeOf(dwarfId)).toEqual(outcome)
    expect(evts(notifier, 'attention.withdraw')).toEqual([])
  })

  it('[S1.18] after a Host restart the dwarf with an open ask is asking again', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    h.asking.stop()

    const next = await bootHost(w)

    expect(next.crew.crew.queries.get(dwarfId)?.status).toBe('asking')
    expect(next.asking.queries.openAskOf(dwarfId)?.providerRequestId).toBe(CALL)
  })

  it('[ADR-002] once the routes stopped, a departure closes no ask and no ask frame is sent', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    const frames = evts(ui, 'ask.closed').length

    h.asking.stop()
    h.crew.crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
    await h.settle(ui, notifier)

    expect(h.asking.queries.openAskOf(dwarfId)?.state).toBe('open')
    expect(evts(ui, 'ask.closed')).toHaveLength(frames)
  })

  it('[S41.09, ADR-016] wiring the hook ingress route persists no ingress port: the listener is boot step 6', async () => {
    const w = world()

    await bootHost(w)

    expect(appMetaIngressPort(w.db as SqliteDatabase).read()).toBeNull()
  })
})
