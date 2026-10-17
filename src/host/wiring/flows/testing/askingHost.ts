// The asking flow's Host (ISSUE-140): one Host start composed as host/main.ts composes it, over a
// temp world with the recorded observed-Claude fixture session, shared by the L2 flow
// (asking.flow.test.ts) and the L8 hook-ingress flow (hookIngress.os.test.ts). Never imported by
// production code (R14). The composition is described in asking.flow.test.ts.
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, onTestFinished } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  HOST_FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  redactSecrets,
  resFrameSchema
} from '@dwarfai/contracts'
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type {
  DwarfId,
  EventId,
  FolderPath,
  HostEpoch,
  Instant,
  MineId,
  ProviderId
} from '../../../kernel/domain/values'
import { FakeAppPaths } from '../../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { FakeProcessControl } from '../../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { FakeSecretReader } from '../../../kernel/fakes/FakeSecretReader'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingShutdownCheckpoint } from '../../../kernel/fakes/RecordingShutdownCheckpoint'
import { RecordingStopAll } from '../../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../../kernel/InProcessEventBus'

import { createAskDrainGate, type AskingEvent, type AskRecord } from '../../../modules/asking'
import { SqliteAskRepository } from '../../../modules/asking/adapters/SqliteAskRepository'
import { FsTranscriptTail } from '../../../modules/asking/adapters/observedClaude/transcriptTail'
import { toolResultLine } from '../../../modules/asking/testing/claudeTranscript'
import { FakeKeystrokeRelay } from '../../../modules/asking/testing/FakeKeystrokeRelay'
import { AppBackgroundNotifierLauncher } from '../../../modules/attention/adapters/AppBackgroundNotifierLauncher'
import { SqliteAttentionLedger } from '../../../modules/attention/adapters/SqliteAttentionLedger'
import { ProviderHistoryScanner } from '../../../modules/ledger/adapters/ProviderHistoryScanner'
import { SqliteLedgerRepository } from '../../../modules/ledger/adapters/SqliteLedgerRepository'
import { createHostGitRepoInspector } from '../../../modules/mines/adapters/FsGitRepoInspector'
import type { SourceWeightScanner } from '../../../modules/mines'
import { OBSERVATION_POLL_MS, createSqliteObservationStores } from '../../../modules/observation'
import type { PreferencesEvent } from '../../../modules/preferences'
import { ClaudeHooksConfigWriter } from '../../../modules/preferences/adapters/external-config/claudeHooks/ClaudeHooksConfigWriter'
import { ConfigWriterEngine } from '../../../modules/preferences/adapters/external-config/configWriterEngine'
import { SqliteChannelTokenStore } from '../../../modules/preferences/adapters/sqlite/SqliteChannelTokenStore'
import { SqliteConfigWriteLedger } from '../../../modules/preferences/adapters/sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from '../../../modules/preferences/adapters/sqlite/SqliteIntegrationSettingStore'
import type { InstallResolver, SuppliersEvent } from '../../../modules/suppliers'
import { SqliteCapabilityRecordStore } from '../../../modules/suppliers/adapters/sqlite/SqliteCapabilityRecordStore'
import { NodeFs } from '../../../platform/fs/NodeFs'
import { openReadOnlySnapshot } from '../../../platform/sqlite/readOnlySnapshot'
import { SqliteLifecycleFactLog } from '../../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { TransportLevel3Sink } from '../../../transport/attention/TransportLevel3Sink'
import { HelloThrottle } from '../../../transport/auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../../../transport/auth/uiToken'
import { collectCapabilities } from '../../../transport/capabilities'
import { acceptConnection } from '../../../transport/connection'
import { ConnectionRegistry } from '../../../transport/connectionRegistry'
import type { HttpIngress } from '../../../transport/ingress/httpIngress'

import { createUpgradeDrain } from '../../../transport/lifecycle/drain'
import { HostStateHolder } from '../../../transport/lifecycle/hostState'
import { createUpgradeTargetRule } from '../../../transport/methods/hostUpgradeRequest'
import { PREFERENCES_FRAMES } from '../../../transport/methods/preferences'
import { SET_CLAUDE_HOOKS_FRAMES } from '../../../transport/methods/setClaudeHooks'
import { SectionRegistry } from '../../../transport/snapshot/sectionRegistry'
import { FrameClient } from '../../../transport/testing/frameClient'
import { inProcessDuplex } from '../../../transport/testing/inProcessDuplex'
import { runBoot, type BootOutcome } from '../../boot'
import { createBootSteps, mintBootEpoch } from '../../bootSteps'
import { hostConfigWriter, persistedIngressPort } from '../../bridges/hostConfigWriter'
import { appMetaIngressPort } from '../../bridges/ingressPort'
import { createHostHookIngress, startHookIngressAtBoot } from '../../hookIngress'
import { composeHostLifecycle } from '../../hostLifecycle'
import { composeObservedBatchSink } from '../../bridges/observedBatchSink'
import { cut1RollbackChoices } from '../../cut1Rollback'
import { createHostDrainGate, routeDrainRechecks } from '../../hostDrainGate'
import { createHostDispatcher } from '../../hostDispatcher'
import { createModuleResetSteps } from '../../moduleResetSteps'
import {
  servePreferences,
  unavailableSecretStore,
  type WiredPreferences
} from '../../preferencesWiring'
import {
  ASKING_FRAMES,
  serveAsking,
  type AskingRouteEvent,
  type AskingWiringDeps,
  type WiredAsking
} from '../../routes/askingRoutes'
import {
  ATTENTION_FRAMES,
  onNotifierAttach,
  serveAttention,
  type AttentionRouteEvent,
  type WiredAttention
} from '../../routes/attentionTransport'
import {
  serveConversation,
  type ConversationRouteEvent,
  type WiredConversation
} from '../../routes/conversation'
import { CONVERSATION_READ_FRAMES } from '../../routes/conversationFrames'
import { serveCrew, type CrewRouteEvent, type WiredCrew } from '../../routes/crew'
import { routeCut1Events } from '../../routes/cut1Routes'
import { wireLedger, type LedgerRouteEvent } from '../../routes/ledger'
import {
  DEFAULT_MINES_SETTINGS,
  serveMines,
  type MinesRouteEvent,
  type WiredMines
} from '../../routes/mines'
import {
  observationAdapters,
  observedProviderFolders,
  wireObservation,
  type WiredObservation
} from '../../routes/observation'
import { wireSuppliers } from '../../suppliersWiring'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures')
/** pending-permission.jsonl: an observed Claude session whose last record is a pending Bash call. */
export const PENDING_PERMISSION = join(
  FIXTURES,
  'claude/hook-keystroke/2.1.x/pending-permission.jsonl'
)
export const FIXTURE_CWD = 'C:\\Users\\j\\work\\sample.project'
export const SESSION = '01a0b000-0000-7000-8000-000000001341'
export const CALL = 'toolu_01KeystrokeBash'
/** The fixture's first record is 2026-09-30T10:00:01Z; the Host starts just before it. */
export const T0 = 1_790_762_398_000 as Instant
/** Before every record of the fixture. */
export const INSTALL_BEFORE_ALL = 1_790_700_000_000 as Instant
/** The port an L2 Host persists as boot step 6's listener would (ADR-016 item 3). */
export const INGRESS_PORT = 41_234
/** Claude Code's settings file on the FakeFs (`CLAUDE_CONFIG_DIR` unset: `~/.claude`, 16 §7.1). */
export const CLAUDE_SETTINGS = '/home/person/.claude/settings.json'
export const CLAUDE = 'claude' as ProviderId
/** OpenCode's catalog id, as host/main.ts passes it to the asking wiring (ISSUE-229). */
export const OPENCODE = 'opencode' as ProviderId

/** One request the fake OpenCode server received from the `http` answer channel. */
export interface OpenCodeServerRequest {
  url: string
  headers: Record<string, string>
  body: unknown
}

export const cleanups: Array<() => void> = []

/** Removes every temp root the finished test made (the test file's `afterEach`). */
export function cleanUp(): void {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
}

export async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

export function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** `text` with every JSON-escaped spelling of `from` replaced by `to`. */
export function jsonPathSwap(text: string, from: string, to: string): string {
  return text.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1))
}

/** Claude Code installed: `claude` resolves on the PATH (inline double, R15). */
export const claudeInstalled: InstallResolver = {
  resolve: (binaries) =>
    Promise.resolve(
      binaries.includes('claude')
        ? { path: '/opt/tools/claude', version: '2.1.263', resolvedVia: 'path' as const }
        : null
    )
}

/** A temp root: a home folder with Claude's folders, the mine's folder and the Host database. */
export function world() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-140-asking-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const folders = observedProviderFolders({}, join(root, 'home'))
  const cwd = join(root, 'mines', 'moria')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'main.ts'), 'x'.repeat(2_048))
  const db = openTemplateCopy().db
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
export type World = ReturnType<typeof world>

export type HostBusEvent =
  | PreferencesEvent
  | SuppliersEvent
  | MinesRouteEvent
  | CrewRouteEvent
  | LedgerRouteEvent
  | ConversationRouteEvent
  | AttentionRouteEvent
  | AskingRouteEvent

/** One Host start over `world`, composed as host/main.ts composes it. */
export interface BootOptions {
  /**
   * Boot step 6 starts the hook ingress on a real 127.0.0.1 listener (L8 only, 17 §1.8), and the
   * Host's composed end of life closes it.
   */
  listen?: boolean
  /**
   * The mines' source-weight scanner: the L2 flow passes `FsSourceWeightScanner`, as host/main.ts
   * does. Its worker entry is a `?modulePath` import that only the L1–L7 vitest config resolves, so
   * the L8 flow passes a fixed weight instead (the mine's tier is not what it proves).
   */
  scanner: SourceWeightScanner
}

export async function bootHost(w: World, options: BootOptions) {
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
  /** The reasons the Host's clean exit was asked for, in order (the upgrade drain's among them). */
  const closes: string[] = []
  const lifecycle = {
    closeCleanly: (reason: string) => {
      closes.push(reason)
      return Promise.resolve()
    }
  }
  // What host/main.ts does: the drain's gate reports each module's gate bound at boot step 4 (#1290).
  const drainGate = createHostDrainGate()
  let stopDrainRechecks: (() => void) | undefined
  const drain = createUpgradeDrain({ gate: drainGate, state, scheduler, lifecycle, log })
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
    drain,
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
  // The OpenCode server the `http` answer channel posts to: a fake that records each request and
  // answers 200 `true`; the password is drawn at run time (no secret value in the repository).
  const openCodePassword = randomBytes(12).toString('hex')
  const openCodeRequests: OpenCodeServerRequest[] = []
  const openCodePlugin: AskingWiringDeps['openCodePlugin'] = {
    providerId: OPENCODE,
    secrets: new FakeSecretReader({
      scheduler,
      values: { 'opencode-password': openCodePassword }
    }),
    post: (url, init) => {
      openCodeRequests.push({ url, headers: { ...init.headers }, body: JSON.parse(init.body) })
      return Promise.resolve({ status: 200, text: () => Promise.resolve('true') })
    }
  }
  const host: {
    preferences?: WiredPreferences
    conversation?: WiredConversation
    observation?: WiredObservation
    crew?: WiredCrew
    mines?: WiredMines
    attention?: WiredAttention
    asking?: WiredAsking
  } = {}
  // Built by step 4 when `options.listen`, started by step 6.
  let ingress: HttpIngress | undefined
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
            scanner: options.scanner,
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
            openCodePlugin,
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
          // What host/main.ts does: the live asks hold the upgrade drain; an ask closing re-checks it.
          drainGate.bind(
            createAskDrainGate({
              asks: new SqliteAskRepository({ db, scope: transactions, clock })
            })
          )
          // A typed constant, not an inline literal: TypeScript 6.0.3 crashes checking that call.
          const recheckDeps: Parameters<typeof routeDrainRechecks>[0] = { events: bus, drain }
          stopDrainRechecks = routeDrainRechecks(recheckDeps)
          // What host/main.ts does: the hook ingress over asking's route; boot step 6 listens.
          if (options.listen === true) {
            ingress = createHostHookIngress({
              routes: asking.hookRoutes,
              portRecord: appMetaIngressPort(db),
              clock,
              log
            })
          }
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
        startHookIngress:
          options.listen === true
            ? () => {
                if (ingress === undefined) throw new Error('step 6 runs after step 4')
                return startHookIngressAtBoot(ingress, log)
              }
            : undefined,
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
  const listening = ingress
  if (listening !== undefined) onTestFinished(() => listening.close())
  // The Host's composed end of life as host/main.ts composes it: the asking routes stopped and the
  // hook ingress closed before the clean exit (no endpoint, checkpoint or process here).
  const endOfLife = composeHostLifecycle({
    checkpoint: new RecordingShutdownCheckpoint([]),
    connections,
    endpoint: { close: () => Promise.resolve() },
    scheduler,
    log,
    sessionEnd: { onSessionEnd: () => undefined },
    stopRoutes: () => {
      stopDrainRechecks?.()
      asking.stop()
    },
    closeIngress: () => listening?.close() ?? Promise.resolve(),
    exit: () => undefined
  })

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
    /** The upgrade drain as host/main.ts builds it (B-M06 enters and starts it). */
    drain,
    closes,
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
    /** `app_meta.ingress_port`: the port the hook ingress persisted, `null` before it listened. */
    ingressPort: (): number | null => appMetaIngressPort(db).read(),
    /** Stop everything and quit as the Host composes its end (ADR-002 D7). */
    stopEverything: () => endOfLife.closeCleanly('stop-all'),
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
     * port (a listening Host's own, else as its listener would); the plaintext token of the hook
     * entry written.
     */
    instantUpdatesOn: async (ui: FrameClient): Promise<string> => {
      // A listening Host persisted its own port at step 6.
      if (options.listen !== true) appMetaIngressPort(db).write(INGRESS_PORT)
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
    /** The OpenCode password the fake server expects, and every request it received. */
    openCodePassword,
    openCodeRequests,
    /**
     * "OpenCode · permission requests" in `state` as its setting row stores it, with an active
     * `opencode-plugin` token while it is on (the plugin file's writer is ISSUE-227/228's); returns
     * the plaintext token the written plugin would carry.
     */
    openCodePermissions: (state: 'off' | 'on-unverified' | 'on-verified'): string => {
      const token = randomBytes(32).toString('hex')
      db.run(
        `UPDATE integration_settings SET state = ?, consent_origin = ?, changed_at = ?
         WHERE id = 'opencode-permissions'`,
        [state, state === 'off' ? null : 'settings', clock.now()]
      )
      db.run(
        `UPDATE channel_tokens SET revoked_at = ? WHERE channel = 'opencode-plugin' AND revoked_at IS NULL`,
        [clock.now()]
      )
      if (state !== 'off') {
        db.run(
          `INSERT INTO channel_tokens (id, channel, token_sha256, created_at) VALUES (?, 'opencode-plugin', ?, ?)`,
          [ids.uuidv7(), createHash('sha256').update(token, 'utf8').digest('hex'), clock.now()]
        )
      }
      return token
    },
    /** The folder observation's index answers for an OpenCode session (its `cwd`). */
    openCodeFolderOf: (providerSessionId: string): string =>
      observation.crew.sessions.byIdentity({ providerId: OPENCODE, providerSessionId })?.cwd ?? '',
    /** An observed OpenCode session (a legacy-launched one is observed) arrived in `mineId`. */
    openCodeDwarf: (mineId: MineId, providerSessionId: string): DwarfId =>
      crew.crew.commands.arrive({
        mineId,
        identity: { providerId: OPENCODE, providerSessionId },
        rank: 'foreman',
        status: 'working'
      }),
    /**
     * One OpenCode plugin report at `/opencode/*` as the ingress hands it to its route: the
     * admission by the presented token (401 otherwise), then the body's delivery after the answer.
     */
    openCodeReport: async (
      token: string,
      body: Record<string, unknown>
    ): Promise<204 | 401 | 400> => {
      const route = asking.hookRoutes.find((r) => r.prefix === '/opencode/')
      if (route === undefined) throw new Error('no OpenCode plugin route was wired')
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
export type Host = Awaited<ReturnType<typeof bootHost>>

export function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id?: string }).id === id
  )
}

/** The `name` frames `client` received, their data. */
export function evts<T = unknown>(client: FrameClient, name: string): T[] {
  return client.frames.flatMap((frame) => {
    if ((frame as { type?: string }).type !== 'evt') return []
    const evt = evtFrameSchema.parse(frame)
    return evt.name === name ? [evt.data as T] : []
  })
}

/** Claude Code's hook body for its permission dialog on the fixture session (ADR-012 item 6). */
export function permissionRequest(w: World): Record<string, unknown> {
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
export async function observedClaude(options: BootOptions) {
  const w = world()
  const h = await bootHost(w, options)
  const mineId = await h.mine()
  const { ui, notifier } = await h.clients()
  const token = await h.instantUpdatesOn(ui)
  w.writeSession()
  await h.poll(ui, notifier)
  const dwarfId = h.dwarfOf()
  return { w, h, mineId, ui, notifier, token, dwarfId }
}

/** The fixture's ask, as the broker stored it. */
export function askOf(h: Host, dwarfId: DwarfId): AskRecord | null {
  return h.asking.queries.openAskOf(dwarfId)
}
