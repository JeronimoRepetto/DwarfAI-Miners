// The cut-3a Host (ISSUE-182): one Host start composed as host/main.ts composes it — the real boot
// steps of bootSteps.ts, the Host dispatcher with every seam-B member served before the bind, the
// endpoint's frame list (wiring/hostFrames.ts), preferences at step 3, and at step 4 suppliers with
// the development build's SimulatedDriver and the person's own Codex app-server driver, jev, the
// ledger, conversation, observation, crew, mines, attention, asking, launching with the
// `LaunchAdvisor` bridge, the launched sessions (wiring/launchedSessions.ts), Stop everything and
// quit, and the Host recovery that step 5 awaits — over a temp world and one copy of the template
// database, which a second Host start can reopen (a Host rebuilt after a crash, CH-01). Shared by
// cut3aHost.test.ts. Never imported by production code (R14).
//
// Every driven port is faked: a FakeClock and FakeScheduler, the suppliers' install resolver
// (Codex found when a case says so), the kernel `ProcessControl` (the conformance harness's
// `RecordingSpawn`, which replays a Codex app-server recording for a spawn of `codex`), the OS
// secret store (`FakeSecretStore`, holding the Jev key when a case says so) and the Jev router (an
// inline recording double, R15). No real process, no network, no provider.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, onTestFinished } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  HOST_FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  redactSecrets,
  resFrameSchema
} from '@dwarfai/contracts'
import type { PreviousEpochEnd } from '../../../kernel/domain/bootIdentity'
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { FolderPath, HostEpoch, Instant, MineId } from '../../../kernel/domain/values'
import { FakeAppPaths } from '../../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingShutdownCheckpoint } from '../../../kernel/fakes/RecordingShutdownCheckpoint'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../../kernel/InProcessEventBus'
import type { ProcessControl } from '../../../kernel/ports/processControl'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import { FsTranscriptTail } from '../../../modules/asking/adapters/observedClaude/transcriptTail'
import { FakeKeystrokeRelay } from '../../../modules/asking/testing/FakeKeystrokeRelay'
import { AppBackgroundNotifierLauncher } from '../../../modules/attention/adapters/AppBackgroundNotifierLauncher'
import { SqliteAttentionLedger } from '../../../modules/attention/adapters/SqliteAttentionLedger'
import type { JevDeps, JevRouter } from '../../../modules/jev'
import {
  type LaunchingEvent,
  type LaunchingRecovery,
  type LaunchingRecoveryDeps,
  type LaunchingStopAll
} from '../../../modules/launching'
import { SqliteRecoveryReportStore } from '../../../modules/launching/adapters/sqlite/SqliteRecoveryReportStore'
import { ProviderHistoryScanner } from '../../../modules/ledger/adapters/ProviderHistoryScanner'
import { SqliteLedgerRepository } from '../../../modules/ledger/adapters/SqliteLedgerRepository'
import { createHostGitRepoInspector } from '../../../modules/mines/adapters/FsGitRepoInspector'
import { FsSourceWeightScanner } from '../../../modules/mines/adapters/FsSourceWeightScanner'
import { createSqliteObservationStores } from '../../../modules/observation'
import type { PreferencesEvent } from '../../../modules/preferences'
import { FakeSecretStore } from '../../../modules/preferences/testing/fakeSecretStore'
import type {
  InstallResolver,
  SupplierCatalogueQueries,
  SupplierEntry,
  SuppliersEvent
} from '../../../modules/suppliers'
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
import { createUpgradeDrain } from '../../../transport/lifecycle/drain'
import { HostStateHolder } from '../../../transport/lifecycle/hostState'
import type { CleanExit } from '../../../transport/lifecycle/cleanExit'
import { createUpgradeTargetRule } from '../../../transport/methods/hostUpgradeRequest'
import { SectionRegistry } from '../../../transport/snapshot/sectionRegistry'
import { FrameClient } from '../../../transport/testing/frameClient'
import { inProcessDuplex } from '../../../transport/testing/inProcessDuplex'
import { runBoot, type BootOutcome } from '../../boot'
import { classifyAfterDetection, createBootSteps } from '../../bootSteps'
import { createLaunchAdvisor } from '../../bridges/launchAdvisor'
import { routingCatalogSource } from '../../bridges/routingCatalogSource'
import { composeObservedBatchSink } from '../../bridges/observedBatchSink'
import { cut1RollbackChoices } from '../../cut1Rollback'
import { emptyDrainGate } from '../../emptyDrainGate'
import { createHostDispatcher } from '../../hostDispatcher'
import { HOST_FRAMES } from '../../hostFrames'
import { composeHostLifecycle } from '../../hostLifecycle'
import { createLaunchedSessions } from '../../launchedSessions'
import { createModuleResetSteps } from '../../moduleResetSteps'
import {
  noOwnedConfigWriter,
  servePreferences,
  type WiredPreferences
} from '../../preferencesWiring'
import {
  serveAsking,
  type AskingRouteEvent,
  type AskingWiringDeps
} from '../../routes/askingRoutes'
import {
  onNotifierAttach,
  serveAttention,
  type AttentionRouteEvent
} from '../../routes/attentionTransport'
import { serveConversation, type ConversationRouteEvent } from '../../routes/conversation'
import { serveCrew, type CrewRouteEvent, type WiredCrew } from '../../routes/crew'
import { routeCut1Events } from '../../routes/cut1Routes'
import { serveJev } from '../../routes/jev'
import { serveLaunching, type WiredLaunching } from '../../routes/launching'
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
import { launchableSource, serveSuppliers } from '../../routes/suppliers'
import { wireSuppliers, type WiredSuppliers } from '../../suppliersWiring'

export const T0 = 1_792_225_100_000 as Instant
export const JEV_KEY = 'ts-flow-182-key'
export const INSTALL_ID = '00000000-0000-7000-8000-0000000182ff'

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

type RouteRequest = Parameters<JevRouter['route']>[0]
type RouteResponse = Awaited<ReturnType<JevRouter['route']>>

/** The recording `JevRouter` double (inline, R15): answers only what a case queued. */
export class RecordingJevRouter implements JevRouter {
  readonly requests: RouteRequest[] = []
  private readonly queued: RouteResponse[] = []

  queue(response: RouteResponse): void {
    this.queued.push(response)
  }

  route(req: RouteRequest): Promise<RouteResponse> {
    this.requests.push(req)
    const next = this.queued.shift()
    return next === undefined
      ? Promise.reject(new Error('RecordingJevRouter: route() called with nothing queued'))
      : Promise.resolve(next)
  }

  routeModel(): Promise<never> {
    return Promise.reject(new Error('RecordingJevRouter: routeModel() is not scripted here'))
  }
}

/** The temp world: a home folder, the mine's folder and one Host database, kept across Host starts. */
export function world() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-182-cut3a-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const folders = observedProviderFolders({}, join(root, 'home'))
  const cwd = join(root, 'mines', 'moria')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'main.ts'), 'x'.repeat(2_048))
  const { db } = openTemplateCopy()
  db.run(`UPDATE app_meta SET install_id = ? WHERE id = 1`, [INSTALL_ID])
  return { root, folders, cwd: cwd as FolderPath, db }
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
  | LaunchingEvent

export interface BootOptions {
  /** This start's epoch (`HelloOk.epoch`, the spawn tag's last field). */
  epoch: string
  /** The kernel process control every module and driver spawns and probes through, over this start's clock. */
  processes: (time: { clock: FakeClock; scheduler: FakeScheduler }) => ProcessControl
  /** The CLIs the one `InstallResolver` finds, with the files their detection stats. */
  installed?: readonly ('codex' | 'claude')[]
  /** The Jev key in the OS secret store; none by default. */
  jevKey?: string
  /** How the previous Host epoch ended (boot step 2); none by default (a first start). */
  previousEpochEnd?: PreviousEpochEnd | null
  /** Jev's capability table, when the composition derives one. */
  jevCapabilities?: JevDeps['capabilities']
  /**
   * Jev's candidates also hold a launch-enabled Claude with these models once its CLI is detected,
   * as flows/jevSuggest.test.ts stands it in: the development build's simulated provider has no
   * models, so Jev has nothing to ask about it, and Claude's stream-json driver is not attached
   * until its permission prompt tool is composed (AMENDMENT-21). Jev's routing catalogue only.
   */
  jevClaudeModels?: readonly string[]
}

/** The real catalogue, whose `launchable()` also answers a launch-enabled Claude once detected. */
function withClaudeCandidate(
  real: SupplierCatalogueQueries,
  models: readonly string[]
): SupplierCatalogueQueries {
  return {
    entry: (id) => real.entry(id),
    capabilities: (id) => real.capabilities(id),
    launchable: async () => {
      const launchable = await real.launchable()
      if (real.entry('claude')?.installed !== true) return launchable
      const claude: SupplierEntry = {
        providerId: 'claude',
        label: 'Claude Code',
        models: [...models],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        permissionModes: ['ask-first', 'accept-edits', 'full-access'],
        installed: true,
        publicLaunch: 'enabled',
        answerChannel: 'available'
      }
      return [...launchable, claude]
    }
  }
}

const TOOLS = '/opt/tools'

export async function bootHost(w: World, options: BootOptions) {
  const { db, folders } = w
  const rollback = cut1RollbackChoices(false)
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const processes = options.processes({ clock, scheduler })
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const epoch = options.epoch as HostEpoch
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  const sections = new SectionRegistry()
  /** What happened, in order: the boot ports as they ran and each state the boot reported. */
  const order: string[] = []
  const recordedState = {
    report: (report: Parameters<HostStateHolder['report']>[0]) => {
      order.push(`state:${report.state}`)
      state.report(report)
    }
  }
  /** The process exits the Host's clean exit asked for. */
  const exits: number[] = []
  // Composed after the boot, as host/main.ts composes it before the bind; read only once composed.
  const composed: { cleanExit?: CleanExit } = {}
  const lifecycle: CleanExit = {
    closeCleanly: (reason) =>
      composed.cleanExit === undefined
        ? Promise.reject(new Error('closeCleanly before the lifecycle was composed'))
        : composed.cleanExit.closeCleanly(reason)
  }
  let launchingStopAll: LaunchingStopAll | undefined
  let launchingRecovery: LaunchingRecovery | undefined
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => state.current().state,
    stopAll: {
      stopAll: (requestId) => {
        if (launchingStopAll === undefined) throw new Error('stop-all before step 4')
        return launchingStopAll.stopAll(requestId)
      }
    },
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
  // What host/main.ts does before the boot: every member is served before its module exists.
  const servedPreferences = servePreferences({ dispatcher, sections, connections })
  const servedMines = serveMines({ dispatcher, sections, connections })
  const servedCrew = serveCrew({ dispatcher, sections })
  const servedConversation = serveConversation({ dispatcher, sections })
  const servedAsking = serveAsking({ dispatcher, sections })
  const servedLaunching = serveLaunching({ dispatcher, sections })
  const servedSuppliers = serveSuppliers({ dispatcher })
  const servedJev = serveJev({ dispatcher })
  const servedAttention = serveAttention({ dispatcher, connections })
  const launched = createLaunchedSessions()

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
  const router = new RecordingJevRouter()
  const secrets = new FakeSecretStore()
  if (options.jevKey !== undefined) await secrets.set('jev-key', options.jevKey)
  const detectionFs = new FakeFs()
  const installed = options.installed ?? []
  for (const binary of installed) detectionFs.addFile(`${TOOLS}/${binary}`, 'cli', 1)
  const resolver: InstallResolver = {
    resolve: (binaries) => {
      const binary = binaries.find((name) => (installed as readonly string[]).includes(name))
      return Promise.resolve(
        binary === undefined
          ? null
          : { path: `${TOOLS}/${binary}`, version: '0.153.4', resolvedVia: 'path' as const }
      )
    }
  }
  const host: {
    suppliers?: WiredSuppliers
    observation?: WiredObservation
    crew?: WiredCrew
    mines?: WiredMines
    launching?: WiredLaunching
    conversation?: ReturnType<typeof servedConversation.wire>
  } = {}
  let wiredPreferences: WiredPreferences | undefined
  const ran = <T>(name: string, port: () => T): (() => T) => {
    return () => {
      order.push(name)
      return port()
    }
  }
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
        resumeResetSaga: async () => {
          wiredPreferences = servedPreferences.wire({
            db,
            transactions,
            bus,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch,
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
            secrets,
            externalConfig: noOwnedConfigWriter,
            ready: () => state.current().state === 'ready'
          })
          await wiredPreferences.loadSecretStatuses()
          return wiredPreferences.resumeOnBoot()
        },
        constructModules: ran('construct-modules', () => {
          const preferences = wiredPreferences
          if (preferences === undefined) throw new Error('step 4 runs after step 3')
          // As host/main.ts: suppliers with the CLI drivers and the launched sessions' resume lookup.
          const suppliers = wireSuppliers({
            publicBuild: false,
            clock,
            scheduler,
            ids,
            fs: detectionFs,
            log,
            installResolver: resolver,
            capabilityRecords: new SqliteCapabilityRecordStore({
              db,
              tx: transactions,
              ids,
              log
            }),
            integrationGate: preferences.integrationGate,
            bus,
            hostEpoch: epoch,
            simulatedSeed: 'seed-182',
            cliDrivers: {
              processControl: processes,
              loginEnv: { PATH: TOOLS },
              home: join(w.root, 'home'),
              platform: 'linux',
              redact: redactSecrets,
              clientInfo: { name: 'dwarfai', version: '0.0.0' },
              resumeContext: launched.resumeContext
            }
          })
          host.suppliers = suppliers
          servedSuppliers.bind(launchableSource(suppliers))
          const jev = servedJev.bind({
            router,
            secretReader: preferences.secretReader,
            routingCatalog: routingCatalogSource(
              options.jevClaudeModels === undefined
                ? suppliers.catalogue
                : withClaudeCandidate(suppliers.catalogue, options.jevClaudeModels)
            ),
            preferences: preferences.preferences.queries,
            log,
            ...(options.jevCapabilities === undefined
              ? {}
              : { capabilities: options.jevCapabilities })
          })
          const ledger = wireLedger({
            repository: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
            transactions,
            bus,
            clock,
            ids,
            hostEpoch: epoch,
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
            hostEpoch: epoch,
            frames: connections
          })
          host.conversation = conversation
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
            hostEpoch: epoch,
            log
          })
          host.observation = observation
          const crew = servedCrew.wire({
            db,
            transactions,
            lifecycleFacts,
            bus,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch,
            log,
            // As host/main.ts: launching's ownership and the live driver session (ISSUE-182).
            links: launched.links({ canDeliverTo: () => false }),
            processes,
            observation: observation.crew,
            outcomes: conversation.conversation.queries
          })
          host.crew = crew
          const mines = servedMines.wire({
            db,
            transactions,
            bus,
            clock,
            scheduler,
            ids,
            fs,
            hostEpoch: epoch,
            log,
            mapSites: [],
            random: () => 0,
            scanner: new FsSourceWeightScanner(),
            ...DEFAULT_MINES_SETTINGS,
            crew: crew.mines,
            ledger: ledger.totals,
            outcomes: conversation.conversation.queries
          })
          host.mines = mines
          crew.route({ commands: mines.mines.commands, queries: mines.mines.queries })
          ledger.route({ mines: mines.mines.queries })
          conversation.route({
            crew: crew.crew.queries,
            mines: mines.mines.queries,
            sessions: suppliers.sessions,
            diagnostics: log
          })
          const attention = servedAttention.wire({
            ledger: new SqliteAttentionLedger({ db, scope: transactions, clock, hostEpoch: epoch }),
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
            hostEpoch: epoch,
            log
          })
          // A typed constant, not an inline literal: TypeScript 6.0.3 crashes checking that call.
          const askingDeps: AskingWiringDeps = {
            db,
            transactions,
            bus,
            sources: { departures: bus, resolutions: bus },
            clock,
            scheduler,
            ids,
            hostEpoch: epoch,
            log,
            frames: connections,
            claudeProviderId: 'claude' as never,
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
            driverAnswers: launched.answers,
            keystrokes: {
              relay: new FakeKeystrokeRelay(),
              transcripts: new FsTranscriptTail(fs),
              redact: redactSecrets
            }
          }
          const asking = servedAsking.wire(askingDeps)
          // As host/main.ts: launching with the LaunchAdvisor bridge, then the launched sessions.
          const launching = servedLaunching.wire({
            db,
            transactions,
            bus,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch,
            installId: INSTALL_ID,
            log,
            frames: connections,
            suppliers,
            mines: mines.mines.queries,
            crew: crew.crew.commands,
            conversation: conversation.conversation.commands,
            advisor: createLaunchAdvisor({ advisor: jev.advisor })
          })
          host.launching = launching
          const ownedEndsDeps: Parameters<WiredCrew['crew']['ownedEnds']>[0] = {
            terminator: crew.terminator,
            bus
          }
          launchingStopAll = launching.launching.stopAll({
            crew: crew.crew.ownedEnds(ownedEndsDeps)
          })
          const recoveryDeps: LaunchingRecoveryDeps = {
            reports: new SqliteRecoveryReportStore({ db, scope: transactions, clock }),
            previousEpochEnd: () => options.previousEpochEnd ?? null,
            processControl: processes,
            crew: {
              markUnrecovered: (dwarfId) => crew.crew.commands.markUnrecovered(dwarfId),
              rebind: (dwarfId, next) => crew.crew.commands.rebind(dwarfId, next),
              sessionClosed: (dwarfId, cause) => crew.crew.commands.sessionClosed(dwarfId, cause),
              get: (dwarfId) => crew.crew.queries.get(dwarfId)
            },
            endSurvivor: (dwarfId) => crew.terminator.end(dwarfId, 'host-recovery'),
            catalogue: suppliers.catalogue,
            deliveries: {
              reconcileSending: (dwarfIds) =>
                conversation.conversation.reconcileSending({
                  dwarfIds,
                  windowMs: 10_000,
                  scheduler,
                  bus
                })
            }
          }
          launchingRecovery = launching.recover(recoveryDeps)
          crew.bindOwnedSessions(
            launched.bind({
              launching: launching.launching,
              suppliers,
              installId: INSTALL_ID,
              hostEpoch: epoch,
              routes: {
                conversation: conversation.conversation.commands,
                asking: asking.broker,
                ledger: ledger.ledger.commands,
                mines: mines.mines.commands,
                log
              },
              crew: crew.crew
            })
          )
          routeCut1Events({
            bus,
            observed: observed.adapters,
            sessions: observation.crew.sessions,
            conversation: conversation.conversation.commands,
            crew: crew.crew,
            mines: mines.mines.queries,
            attention: attention.attention
          })
        }),
        // As host/main.ts: the classification waits for the start-up detection and probes.
        recoverSessions: ran('recover-sessions', () => {
          const recovery = launchingRecovery
          if (recovery === undefined || host.suppliers === undefined) {
            throw new Error('step 5 runs after step 4')
          }
          return classifyAfterDetection({
            detection: host.suppliers.bootDetection,
            classify: () => recovery.start().classified
          })
        }),
        startHookIngress: ran('start-endpoints', () => Promise.resolve()),
        startObservation: ran('start-observation', () => host.observation?.start?.()),
        startModules: ran('start-modules', () => host.mines?.start())
      }),
    {
      log,
      clock,
      state: recordedState,
      privilege: () =>
        Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
      paths: { ok: true, value: new FakeAppPaths({ userDataDir: w.root }) },
      runtime: { os: 'linux', arch: 'x64', node: '24.18.1' },
      exit: () => undefined
    }
  )
  // The start-up detection's budgets run on the FakeScheduler: time moves while the boot runs.
  let booted = false
  void boot.finally(() => (booted = true))
  for (let pumped = 0; !booted && pumped < 400; pumped += 1) {
    await tick()
    if (!booted) clock.advance(25)
  }
  expect(await boot).toEqual({ kind: 'ready' })
  const { suppliers, observation, crew, mines, launching, conversation } = host
  if (
    suppliers === undefined ||
    observation === undefined ||
    crew === undefined ||
    mines === undefined ||
    launching === undefined ||
    conversation === undefined
  ) {
    throw new Error('boot step 4 wired no module')
  }
  onTestFinished(() => observation.observation.control.stop())
  // The Host's composed end of life as host/main.ts composes it.
  composed.cleanExit = composeHostLifecycle({
    checkpoint: new RecordingShutdownCheckpoint([]),
    connections,
    endpoint: { close: () => Promise.resolve() },
    scheduler,
    log,
    sessionEnd: { onSessionEnd: () => undefined },
    stopRoutes: () => launching.stop(),
    exit: (code) => exits.push(code)
  })

  const token = new UiToken()
  await token.issue(join(w.root, 'run'))
  const secret = readFileSync(join(w.root, 'run', UI_TOKEN_FILE), 'utf8')
  /** A `ui` client attached over its own in-process duplex, its hello.ok received. */
  const attach = async () => {
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
          frames: HOST_FRAMES,
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
      role: 'ui',
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
    return `01890a5d-ac96-774b-bcce-b30218${String(nextRid).padStart(6, '0')}`
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
  /** Moves the clock by `ms` in 50 ms steps, letting everything it starts run in between. */
  const run = async (ms: number, ...clients: FrameClient[]) => {
    let left = ms
    do {
      const step = Math.min(50, left)
      clock.advance(step)
      left -= step
      await settle(...clients)
    } while (left > 0)
  }
  return {
    clock,
    log,
    published,
    order,
    exits,
    router,
    dispatcher,
    sections,
    suppliers,
    crew,
    mines,
    launching,
    conversation,
    attach,
    call,
    rid,
    settle,
    run,
    /** Declares the world's folder as a mine (S3.01) and lets its first walk run. */
    mine: async (): Promise<MineId> => {
      const declared = await mines.mines.commands.declare(w.cwd)
      if (!declared.ok || !('mineId' in declared.value)) throw new Error('the mine was refused')
      clock.advance(DEFAULT_MINES_SETTINGS.automaticWalkDelayMs)
      await settle()
      return declared.value.mineId
    },
    /** The `type` events the Host bus carried. */
    events: <T>(type: string): T[] =>
      published.flatMap((event) => (event.type === type ? [event.payload as T] : [])),
    db: db as SqliteDatabase
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
