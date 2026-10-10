// The DwarfAI Host's composition root (16 §8.1, 05 §2.3; ADR-002 D1): the only file that builds
// the platform adapters and kernel ports, which it hands to the boot (host/wiring/boot.ts) and its
// steps (host/wiring/bootSteps.ts). It runs from the app's own executable with
// ELECTRON_RUN_AS_NODE=1 (kept by SP-04), built to `out/host/main.js` by
// electron.vite.host.config.ts, and never imports `electron` (R7) or the UI trees (R10).
//
// It arms no parent-death watchdog and no idle timer: the Host never exits on its own (ADR-002 D1,
// D7; OQ-63; AMENDMENT-5). It exits through the boot's `exit`, for a refusal (ALREADY_RUNNING,
// ELEVATED_REFUSED, NO_DATA_DIR) or a failed boot, after a logged uncaught error (wiring/uncaught.ts,
// FM-001), and otherwise only through the clean exit
// (composeHostLifecycle: checkpoint, `host.closing`, endpoint closed, exit 0), which the OS session
// end, Stop everything and quit (`host.shutdown {stop-all}`, ISSUE-029) and the upgrade drain
// (`host.upgrade.request` or `host.shutdown {upgrade-drain}`, ISSUE-032) start. What keeps the
// process running after `ready` is the UI endpoint the bind step listens on (createUiEndpoint,
// ISSUE-022).
//
// The boot reports its lifecycle into the transport's HostStateHolder, which `hello.ok` and
// HOST_NOT_READY read and which sends `host.state` to the `ui` connections through the
// ConnectionRegistry. The seam-B Dispatcher comes from wiring/hostDispatcher.ts, which registers
// the transport's own `ping`, `events.subscribe` and `host.shutdown` and where each method joins
// with the issue that serves it. `host.shutdown {stop-all}` asks the StopAllPort to end every
// owned session: bound to the empty-owner implementation, since the Host owns no session yet,
// until the launching module serves it (later: ISSUE-175).
// The upgrade drain asks the DrainGate what is still open: bound to the empty implementation of
// cut 0, so it drains at once, until the launching (EPIC-10) and asking (EPIC-08) modules report
// their blockers; a `host.upgrade.request` target must be a direct child of the ADR-002 D5
// versioned-copy root, named by the same rule the UI's launcher uses (14 §1.10).
//
// Boot step 2 opens `<hostDataDir>/dwarfai.db` and keeps the Host epoch (createHostDatabase,
// ISSUE-039); its checkpoint is the clean exit's (the clean-shutdown marker), and a newer file
// adds `db-read-only` to `hello.ok.capabilities`. `session.snapshot` (ISSUE-026) serves the sections of the
// SectionRegistry, advertised as `section:<name>`: at cut 0 the `meta` section only, over the
// boot-state SnapshotMetaSource bound here (`resetEpoch` from `app_meta`, `minesEverKnown` false
// until the mines module reads its table, later: ISSUE-082). Boot step 3 wires the preferences module
// over the database step 2 opened (ISSUE-226: wiring/preferencesWiring.ts, with the FeatureFlagReader,
// the Reset saga's cleanup and the cut-1 bindings that stand in for the OS secret store and the
// config writers; ISSUE-121: the saga's participants are the mines, crew, observation, ledger and
// conversation steps of wiring/moduleResetSteps.ts, built over the database alone, and the ledger's
// install-moment writer, the one SqliteLedgerRepository the ledger is wired over at step 4) and
// resumes an unfinished Reset saga before anything else is constructed and before any command is
// accepted (05 §2.3; 16 §8.2). Since cut 2 (ISSUE-323) step 3 also builds the one config writer:
// the ConfigWriterEngine over the Host database with the Claude Code hooks target
// (ClaudeHooksConfigWriter on `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`, the one file the
// revert mode reverts too), behind wiring/bridges/hostConfigWriter.ts (the hook entry is written
// only once the hook ingress persisted its port, `app_meta.ingress_port`; the OpenCode plugin
// target stays the legacy installer's), the SqliteChannelTokenStore the hook ingress's lookup
// reads, the first-run step's answer (B-M40), and, right after the saga resume, the boot
// re-verification of the config writes a crash left unverified (16 §7.3, 07 S14.11). Boot step 4 constructs the other modules,
// each wired by its issue: suppliers (ISSUE-159) with the one CliInstallResolver, the
// SqliteCapabilityRecordStore, the Host's event bus and the integration gate bridge to preferences;
// the ledger (ISSUE-096: wiring/routes/ledger.ts) over the SqliteLedgerRepository and the coal
// backfill's ProviderHistoryScanner (its folders folded by the mines' git inspector), with its
// `ledger.changed` frame and its `MineMeasured` → `creditSealedUnits` route; observation (ISSUE-095:
// wiring/routes/observation.ts) over its three SQLite stores, the Claude, Codex, Antigravity and
// OpenCode adapters reading the providers' own folders (read only; SQLite files through the
// read-only snapshot), its provider-error route to diagnostics and the ObservedBatchSink bridge
// (wiring/bridges/observedBatchSink.ts) with the ledger's half and conversation's; conversation
// (ISSUE-108: wiring/routes/conversation.ts) before it, over the SqliteMessageLog and
// SqliteActivityLog and the one SqliteLifecycleFactLog it shares with crew (05 §4), with B-M26
// `conversation.feed`, B-M27 `conversation.mineHistory` and the `tails` section served before the
// bind and its `conversation.appended`, `turn.ended` and outcome `dwarf.changed` frames
// (wiring/routes/conversationFrames.ts); crew (ISSUE-094: wiring/routes/crew.ts) with that
// SqliteLifecycleFactLog, the SessionTerminator
// bridge over the kernel's process control and observation's process identities and
// `recordEnded`, its identity index over observation's stores, and its `dwarfs` section and B-M41
// served before the bind; mines (ISSUE-093: wiring/routes/mines.ts) over crew's ends and queries,
// with the FsSourceWeightScanner of its scoring walks, its seam-B members (B-M16…B-M20) and
// `mines` section served before the bind, its board frames (the provider-error toast among them)
// and the provider-error route to `checkFolder`, reading each mine's totals from the ledger, and the
// Reset saga's walk route (`MetricsResetStarted` → every walk aborted, each recreated mine walked,
// ISSUE-121); then
// crew's observation routes, the boot recompute of the dwarf statuses from their persisted facts
// (S1.18) and the ledger's backfill folder resolution over the mines' queries; attention (ISSUE-119:
// wiring/routes/attentionTransport.ts) over the SqliteAttentionLedger, the TransportLevel3Sink, the
// AppBackgroundNotifierLauncher (this executable `--background`, after the app folder in a
// development build) and the `AttentionSettings` bridge to preferences, with B-M07 `presence` and
// B-M08 `attention.clicked` served before the bind, the attention frames advertised, and the
// connection registry feeding the presence union and the tray notifier supervisor; then the
// conversation's routes (its mine history, tails and frames over crew's and mines' queries) and the
// per-mine coal backfill (`MineCreated` / `MineReattached` → `runMineCoalBackfill`, O-11-10) and the
// end of a Reset metrics (`MetricsResetFinished` → held units credited, then the backfill, ISSUE-121); then
// asking (ISSUE-140: wiring/routes/askingRoutes.ts) over the SqliteAskRepository, conversation's
// AnswerRecords, the observed-Claude keystroke channel (no relay into a terminal yet, later: ISSUE-167),
// with B-M30…B-M32 and the `asks` section served before the bind, its frames, the Claude hook ingress
// route bound to the active channel-token lookup (listening is step 6's, later: ISSUE-209) and its
// `ask.*` and departure routes, stopped at the clean exit; last,
// the cut-1 cross-epic routes (ISSUE-120: wiring/routes/cut1Routes.ts), observed turn ends into
// conversation, `TurnEnded` into crew and attention, the next turn start and the departures
// withdrawing attention keys and closing activity runs. The others join later. With both halves of the bridge in place its sink is real (ISSUE-108), so step 7
// starts observation (`WiredObservation.start`: the catch-up, then the live loop). After step 7
// (`startModules`) the mines restart the walks a stopped Host left and start their folder-check
// schedule. After `ready`, the coal backfill. A cut-1 rollback build (wiring/cut1Rollback.ts,
// ISSUE-122) wires observation over a sink that writes nothing, so observation, the coal backfill
// and the per-mine backfill never run, and attention over a level-3 sink that delivers nothing: the
// legacy observer, ledger and notifier are the one observer, ledger and notifier again.
//
// `--revert-integrations` (ADR-016 item 7; ISSUE-225): UI main runs the Host copy with the flag, and
// the process takes the revert mode of wiring/revertIntegrations.ts instead of the boot above:
// stop a running Host (`host.shutdown {stop-all}`), take the endpoint, revert every active
// `config_writes` row, exit with its code. No step of the normal boot runs in that mode.
import { homedir } from 'node:os'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION, redactSecrets } from '@dwarfai/contracts'
import { FsTranscriptTail } from './modules/asking/adapters/observedClaude/transcriptTail'
import { AppBackgroundNotifierLauncher } from './modules/attention/adapters/AppBackgroundNotifierLauncher'
import { SqliteAttentionLedger } from './modules/attention/adapters/SqliteAttentionLedger'
import { createDiagnostics, logLevelFromEnv } from './modules/diagnostics'
import { ProviderHistoryScanner } from './modules/ledger/adapters/ProviderHistoryScanner'
import { SqliteLedgerRepository } from './modules/ledger/adapters/SqliteLedgerRepository'
import { ClaudeHooksConfigWriter } from './modules/preferences/adapters/external-config/claudeHooks/ClaudeHooksConfigWriter'
import { ConfigWriterEngine } from './modules/preferences/adapters/external-config/configWriterEngine'
import { SqliteChannelTokenStore } from './modules/preferences/adapters/sqlite/SqliteChannelTokenStore'
import { SqliteConfigWriteLedger } from './modules/preferences/adapters/sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from './modules/preferences/adapters/sqlite/SqliteIntegrationSettingStore'
import { createHostGitRepoInspector } from './modules/mines/adapters/FsGitRepoInspector'
import { FsSourceWeightScanner } from './modules/mines/adapters/FsSourceWeightScanner'
import type { LedgerRepository } from './modules/ledger'
import type { MapSite } from './modules/mines'
import type { PreferencesEvent } from './modules/preferences'
import type { SuppliersEvent } from './modules/suppliers'
import { createSqliteObservationStores, type ObservedBatchSink } from './modules/observation'
import { createHostInstallResolver } from './modules/suppliers/adapters/install/hostInstallResolver'
import { SqliteCapabilityRecordStore } from './modules/suppliers/adapters/sqlite/SqliteCapabilityRecordStore'
import { NodeScheduler } from './platform/clock/NodeScheduler'
import { SystemClock } from './platform/clock/SystemClock'
import { createNodeEndpointFacts } from './platform/endpoint/nodeEndpointEnv'
import { SqliteLifecycleFactLog } from './platform/sqlite/SqliteLifecycleFactLog'
import { openReadOnlySnapshot } from './platform/sqlite/readOnlySnapshot'
import { createNativeOwnerOnlyDirectory } from './platform/endpoint/win-pipe/nativeOwnerOnlyDirectory'
import { createNativeProcessInJob } from './platform/endpoint/win-pipe/nativeProcessInJob'
import {
  createNativeOwnerOnlyPipe,
  winPipePrebuildsDir
} from './platform/endpoint/win-pipe/nativeOwnerOnlyPipe'
import { NodeFs } from './platform/fs/NodeFs'
import { UuidV7Generator } from './platform/ids/UuidV7Generator'
import { EnvAppPaths } from './platform/paths/EnvAppPaths'
import {
  buildKindOf,
  thisProcessHostLogDir,
  thisProcessReleaseHostDataDir
} from './platform/paths/releaseDataDir'
import { hostCopyRootFacts } from './platform/paths/versionedCopyRoot'
import { NodeProcessControl, createQueryRunner } from './platform/process/NodeProcessControl'
import { nodeOsSessionSignals } from './platform/process/osSessionSignals'
import { createPrivilegeCheck } from './platform/process/privilege'
import { hostRuntime } from './platform/process/runtimeFacts'
import { createHostFileProtection } from './platform/sqlite/fileProtection'
import { SqliteResetCleanup } from './platform/sqlite/resetCleanup'
import { migrationsFor } from './platform/sqlite/migrations'
import { TransportLevel3Sink } from './transport/attention/TransportLevel3Sink'
import { mintCredential } from './transport/auth/mintCredential'
import { ConnectionRegistry } from './transport/connectionRegistry'
import { TRANSPORT_FRAMES } from './transport/events/framePublisher'
import { BOARD_FRAMES } from './transport/frames/board'
import { LEDGER_FRAMES } from './transport/frames/ledger'
import { createUpgradeDrain } from './transport/lifecycle/drain'
import { HostStateHolder, LIFECYCLE_FRAMES } from './transport/lifecycle/hostState'
import { createUpgradeTargetRule } from './transport/methods/hostUpgradeRequest'
import { PREFERENCES_FRAMES } from './transport/methods/preferences'
import { RESET_FRAMES } from './transport/methods/resetMetrics'
import { SET_CLAUDE_HOOKS_FRAMES } from './transport/methods/setClaudeHooks'
import { HostIdentityFile } from './transport/runFiles/hostIdentityFile'
import { SNAPSHOT_TAIL, type SnapshotMetaSource } from './transport/snapshot/metaSection'
import { SectionRegistry } from './transport/snapshot/sectionRegistry'
import { NodeRunFileWriter } from './transport/runFiles/nodeRunFileWriter'
import { errorCode, runBoot } from './wiring/boot'
import { createHostDispatcher } from './wiring/hostDispatcher'
import {
  createBootSteps,
  createUiEndpoint,
  evaluateWelcomeAfterDetection,
  mintBootEpoch
} from './wiring/bootSteps'
import {
  enablableInstalledTools,
  hostConfigWriter,
  persistedIngressPort
} from './wiring/bridges/hostConfigWriter'
import { appMetaIngressPort } from './wiring/bridges/ingressPort'
import { suppliersInstalledTools } from './wiring/bridges/installedTools'
import { composeObservedBatchSink } from './wiring/bridges/observedBatchSink'
import { CUT_1_ROLLBACK_CHOICES } from './wiring/cut1Rollback'
import { createFeatureFlagReader, featureFlagConfigFilePath } from './wiring/featureFlagReader'
import { createHostDatabase, HOST_DB_FILE, type HostDatabase } from './wiring/hostDatabase'
import { composeHostLifecycle } from './wiring/hostLifecycle'
import { installUncaughtHandlers } from './wiring/uncaught'
import { EXIT_CODES } from './wiring/exitCodes'
import {
  createNodeRevertIntegrations,
  dispatchHostMode,
  runRevertIntegrations
} from './wiring/revertIntegrations'
import { createModuleResetSteps, type WiredModuleResetSteps } from './wiring/moduleResetSteps'
import { emptyDrainGate } from './wiring/emptyDrainGate'
import { emptyOwnerStopAll } from './wiring/emptyOwnerStopAll'
import {
  servePreferences,
  unavailableSecretStore,
  type WiredPreferences
} from './wiring/preferencesWiring'
import {
  ASKING_FRAMES,
  NO_KEYSTROKE_RELAY,
  serveAsking,
  type AskingRouteEvent,
  type AskingWiringDeps,
  type WiredAsking
} from './wiring/routes/askingRoutes'
import {
  ATTENTION_FRAMES,
  onNotifierAttach,
  serveAttention,
  type AttentionRouteEvent,
  type WiredAttention
} from './wiring/routes/attentionTransport'
import {
  serveConversation,
  type ConversationRouteEvent,
  type WiredConversation
} from './wiring/routes/conversation'
import { CONVERSATION_READ_FRAMES } from './wiring/routes/conversationFrames'
import { serveCrew, type CrewRouteEvent, type WiredCrew } from './wiring/routes/crew'
import { routeCut1Events } from './wiring/routes/cut1Routes'
import {
  routeMineBackfillWhenObserving,
  routeResetFinished,
  startBackfillWhenObserving,
  wireLedger,
  type LedgerRouteEvent,
  type WiredLedger
} from './wiring/routes/ledger'
import {
  DEFAULT_MINES_SETTINGS,
  serveMines,
  type MinesRouteEvent,
  type WiredMines
} from './wiring/routes/mines'
import {
  CLAUDE_CONFIG_DIRS_INVALID_EVENT,
  observationAdapters,
  observedProviderFolders,
  readHostSettings,
  wireObservation,
  type WiredObservation
} from './wiring/routes/observation'
import { isPublicBuild, wireSuppliers, type WiredSuppliers } from './wiring/suppliersWiring'
import { HostInvariantError, InProcessEventBus } from './kernel'
import type { ProviderId } from './kernel/domain/values'
import type { CleanExit } from './transport/lifecycle/cleanExit'

/** Every event the Host's one bus carries so far. */
type HostEvent =
  | PreferencesEvent
  | SuppliersEvent
  | MinesRouteEvent
  | CrewRouteEvent
  | LedgerRouteEvent
  | ConversationRouteEvent
  | AttentionRouteEvent
  | AskingRouteEvent

/** The app's version, stamped by electron.vite.host.config.ts from package.json. */
declare const __DWARFAI_APP_VERSION__: string
/** The git commit (short) of this build (20 §3.1), stamped by electron.vite.host.config.ts. */
declare const __DWARFAI_BUILD_ID__: string

async function main(): Promise<void> {
  const entry = fileURLToPath(import.meta.url)
  // `out/host/main.js` → the app root (the repository in dev, `app.asar` when packaged).
  const appRoot = dirname(dirname(dirname(entry)))
  // FM-012, S12.04: the Host's own IsProcessInJob is read first, natively, before the Host spawns anything. libuv adds
  // the process itself to a job of its own at its first non-detached spawn, so a later read always says in-job
  // (privilege.ts; ISSUE-056). Creating the check takes that read; it spawns nothing.
  const runQuery = createQueryRunner()
  const privilege = createPrivilegeCheck({
    runQuery,
    readInJob: createNativeProcessInJob({ prebuildsDir: winPipePrebuildsDir(appRoot) })
  })
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  // Packaged when this entry sits inside the executable's own resources folder (SP-04: under
  // ELECTRON_RUN_AS_NODE `process.resourcesPath` is that folder).
  const isPackaged = resourcesPath !== undefined && isInside(resourcesPath, entry)
  const paths = EnvAppPaths.create({
    env: process.env,
    execPath: process.execPath,
    resourcesPath,
    isPackaged
  })

  const clock = new SystemClock()
  const fs = new NodeFs()
  // `<userData>/logs/` beside the hostDataDir (ADR-026 item 1). Without DWARFAI_HOST_DATA_DIR the
  // boot's NO_DATA_DIR refusal still reaches a log: the documented folder of this build (19 §3).
  const log = createDiagnostics({
    fs,
    clock,
    logDir: thisProcessHostLogDir({
      isPackaged,
      hostDataDir: paths.ok ? paths.value.userDataDir : null
    }),
    appVersion: __DWARFAI_APP_VERSION__,
    level: logLevelFromEnv(process.env),
    appRoot
  })
  // 19 §9.1 `uncaught`, §11 (FM-001): logged, flushed, then the Host exits non-zero and the UI
  // sees the crash.
  installUncaughtHandlers({ process, log, exit: (code) => process.exit(code) })
  const scheduler = new NodeScheduler({
    onTaskError: (error) =>
      log.record({
        level: 'error',
        event: 'uncaught',
        subsystem: 'host',
        errCode: errorCode(error),
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {})
      })
  })
  const ids = new UuidV7Generator({ clock })
  const base: HostBase = {
    appRoot,
    isPackaged,
    paths,
    privilege,
    runQuery,
    clock,
    fs,
    log,
    scheduler,
    ids
  }
  // `--revert-integrations` (ADR-016 item 7; ISSUE-225): the revert mode instead of the normal
  // boot, which then never runs; the process exits with the command's code.
  await dispatchHostMode({
    argv: process.argv,
    revertIntegrations: () => revertIntegrationsHere(base),
    boot: () => bootHost(base),
    exit: (code) => {
      process.exitCode = code
      void log.flush().finally(() => process.exit(code))
    }
  })
}

/** What every mode of the Host process is built over, before the mode is chosen. */
interface HostBase {
  appRoot: string
  isPackaged: boolean
  paths: ReturnType<typeof EnvAppPaths.create>
  privilege: ReturnType<typeof createPrivilegeCheck>
  runQuery: ReturnType<typeof createQueryRunner>
  clock: SystemClock
  fs: NodeFs
  log: ReturnType<typeof createDiagnostics>
  scheduler: NodeScheduler
  ids: UuidV7Generator
}

/**
 * The revert mode over this machine (wiring/revertIntegrations.ts): this Host's endpoint, database
 * and the Claude Code settings file observation reads (`CLAUDE_CONFIG_DIR`, else `~/.claude`). It
 * needs DWARFAI_HOST_DATA_DIR as the boot does (NO_DATA_DIR otherwise).
 */
async function revertIntegrationsHere(base: HostBase): Promise<number> {
  const { appRoot, paths, runQuery, clock, fs, log, scheduler, ids } = base
  if (!paths.ok) {
    log.record({
      level: 'error',
      event: 'host.no-data-dir',
      subsystem: 'host',
      causeClass: paths.error
    })
    return EXIT_CODES.NO_DATA_DIR
  }
  const hostDataDir = paths.value.userDataDir
  const prebuildsDir = winPipePrebuildsDir(appRoot)
  const protection = createHostFileProtection({
    log,
    ownerOnlyDirectory: createNativeOwnerOnlyDirectory({ prebuildsDir })
  })
  return runRevertIntegrations(
    createNodeRevertIntegrations({
      hostDataDir,
      facts: createNodeEndpointFacts({ hostDataDir, runQuery }),
      ownerOnlyPipe: createNativeOwnerOnlyPipe({ prebuildsDir }),
      client: {
        appVersion: __DWARFAI_APP_VERSION__,
        buildId: __DWARFAI_BUILD_ID__,
        pid: process.pid
      },
      protocolVersion: PROTOCOL_VERSION,
      open: {
        buildKind: buildKindOf(paths.value),
        releaseDataDir: thisProcessReleaseHostDataDir(),
        appVersion: __DWARFAI_APP_VERSION__,
        migrations: migrationsFor({ clock, ids })
      },
      protectDbFiles: (dbPath) => protection.dbFiles(dbPath),
      fs,
      clock,
      ids,
      scheduler,
      log,
      claudeSettingsPath: claudeSettingsPathHere(),
      platform: hostRuntime().os as NodeJS.Platform
    })
  )
}

/**
 * Claude Code's `settings.json` (16 §7.1), the one file DwarfAI's hook entry is written to and
 * reverted from: `CLAUDE_CONFIG_DIR`, else `~/.claude`, the root Claude Code itself reads its
 * settings from. The extra roots of `CLAUDE_CONFIG_DIRS` (#1264) are observed, never written: the
 * hooks writer names one target (16 §7.1), and the boot and the revert mode name the same one.
 */
function claudeSettingsPathHere(): string {
  return join(observedProviderFolders(process.env, homedir()).claudeConfigDir, 'settings.json')
}

/** The normal boot (16 §8.2): every step, then the Host serves until its clean exit. */
async function bootHost(base: HostBase): Promise<void> {
  const { appRoot, isPackaged, paths, privilege, runQuery, clock, fs, log, scheduler, ids } = base
  const epoch = mintBootEpoch(ids)
  const connections = new ConnectionRegistry()
  const hostState = new HostStateHolder(connections)
  // The dispatcher serves `host.shutdown`, which ends in the clean exit, which closes the endpoint
  // that serves the dispatcher. This forward reference breaks that cycle: the boot callback sets
  // it before the bind step listens, so no request can reach it unset.
  let cleanExit: CleanExit | undefined
  const lifecycle: CleanExit = {
    closeCleanly: (reason) =>
      cleanExit === undefined
        ? Promise.reject(new HostInvariantError('closeCleanly before the lifecycle was composed'))
        : cleanExit.closeCleanly(reason)
  }
  // Opened by boot step 2 (createHostDatabase below). `session.snapshot` is served only once the
  // Host is past `starting` and `migrating` (HOST_NOT_READY before), so after step 2 opened it.
  let database: HostDatabase | undefined
  // The modules boot steps 3 and 4 construct, for the bridges and transport methods that join later.
  const modules: {
    preferences?: WiredPreferences
    suppliers?: WiredSuppliers
    ledger?: WiredLedger
    conversation?: WiredConversation
    /** Observation's batch sink, as the cut-1 rollback choice returned it. */
    batchSink?: ObservedBatchSink
    observation?: WiredObservation
    crew?: WiredCrew
    mines?: WiredMines
    attention?: WiredAttention
    asking?: WiredAsking
  } = {}
  // Built by boot step 3 for the Reset saga, used again by step 4: the ledger's one repository (its
  // install-moment writer, then the module's) and the cut-1 module steps, whose walk route step 4
  // binds once mines exists (ISSUE-121).
  let ledgerRepository: LedgerRepository | undefined
  // Built by boot step 3: the one config writer engine, whose boot re-verification step 3 runs
  // right after the saga resume (16 §7.3).
  let configWriter: ConfigWriterEngine | undefined
  let resetSteps: WiredModuleResetSteps | undefined
  // No spawn-site table reaches the Host yet: no site is stored, and the map places each marker
  // itself (chooseMapSite's documented fallback). The mines module and its Reset step share it.
  const mapSites: readonly MapSite[] = []
  // The Host's one event bus (16 §2.3), created by boot step 3 over the connection step 2 opened;
  // each module's events join its union with the module.
  let bus: InProcessEventBus<HostEvent> | undefined
  // The module sections join this registry here, each with its module (16 §8.2 step 4).
  const sections = new SectionRegistry()
  const snapshotMeta: SnapshotMetaSource = {
    hostVersion: () => __DWARFAI_APP_VERSION__,
    state: () => hostState.current().state,
    snapshotTail: () => SNAPSHOT_TAIL,
    // app_meta.reset_epoch (ISSUE-039).
    resetEpoch: () => {
      if (database === undefined) {
        throw new HostInvariantError('resetEpoch is read after boot step 2 opened the database')
      }
      return database.resetEpoch()
    },
    // Cut 0: the `mines` table has no row yet, so false is the true value (later: ISSUE-082 reads it).
    minesEverKnown: () => false
  }
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => hostState.current().state,
    // Cut 0: no owned session exists yet (later: ISSUE-175 binds launching.stopAll).
    stopAll: emptyOwnerStopAll,
    lifecycle,
    connections,
    epoch,
    // Cut 0: nothing is open or in flight, so the drain goes at once (later: EPIC-08, EPIC-10).
    drain: createUpgradeDrain({
      gate: emptyDrainGate,
      state: hostState,
      scheduler,
      lifecycle,
      log
    }),
    upgradeTarget: createUpgradeTargetRule(
      hostCopyRootFacts({ build: buildKindOf({ isPackaged }) })
    ),
    ids,
    sections,
    snapshotMeta
  })
  // Served before the boot binds the endpoint, so every hello.ok lists them (14 §1.3); boot step 3
  // constructs the module they forward to.
  const servedPreferences = servePreferences({ dispatcher, sections, connections })
  const servedMines = serveMines({ dispatcher, sections, connections })
  const servedCrew = serveCrew({ dispatcher, sections })
  // After the board's sections: `tails` follows the board chunks (14 §4.2).
  const servedConversation = serveConversation({ dispatcher, sections })
  // B-M30…B-M32 and the `asks` section (ISSUE-140).
  const servedAsking = serveAsking({ dispatcher, sections })
  const servedAttention = serveAttention({ dispatcher, connections })
  const processControl = new NodeProcessControl({
    scheduler,
    diagnostics: log,
    runCommand: runQuery
  })

  const exit = (code: number): void => {
    // The last records reach the segment first; then the Host ends, whatever handles it holds.
    process.exitCode = code
    void log.flush().finally(() => process.exit(code))
  }

  // The Host's settings as the shipped layering reads them (environment, then the userData config
  // file): where CLAUDE_CONFIG_DIRS comes from for observation and the coal backfill (HO-09).
  const hostSettings = await readHostSettings(
    process.env,
    fs,
    paths.ok ? featureFlagConfigFilePath(paths.value.userDataDir) : null
  )
  const booted = await runBoot(
    (dataDir) => {
      // Opened by boot step 2; the epoch it keeps is this boot's (mintBootEpoch, one owner).
      const opened = createHostDatabase({
        path: join(dataDir.userDataDir, HOST_DB_FILE),
        epoch,
        clock,
        log,
        processControl,
        open: {
          buildKind: buildKindOf(dataDir),
          releaseDataDir: thisProcessReleaseHostDataDir(),
          appVersion: __DWARFAI_APP_VERSION__,
          migrations: migrationsFor({ clock, ids })
        },
        // Owner-approved amendment (2026-10-01, ISSUE-041): protected owner-only DACL on the
        // Windows data directory (SP-05 run\ row), replacing 09 §9's inherited profile ACL. The
        // helper binary is loaded on its first (Windows-only) call.
        protectFiles: createHostFileProtection({
          log,
          ownerOnlyDirectory: createNativeOwnerOnlyDirectory({
            prebuildsDir: winPipePrebuildsDir(appRoot)
          })
        })
      })
      database = opened
      // run/host.identity: written after the bind, deleted at the clean exit (ADR-002 D3, D7).
      const identityFile = new HostIdentityFile({
        runDir: join(dataDir.userDataDir, 'run'),
        writer: new NodeRunFileWriter(),
        processes: processControl,
        pid: process.pid,
        epoch
      })
      const endpoint = createUiEndpoint({
        facts: createNodeEndpointFacts({ hostDataDir: dataDir.userDataDir, runQuery }),
        log,
        scheduler,
        clock,
        ids,
        identity: {
          hostVersion: __DWARFAI_APP_VERSION__,
          buildId: __DWARFAI_BUILD_ID__,
          protocolVersion: PROTOCOL_VERSION
        },
        pid: process.pid,
        epoch,
        state: () => hostState.current(),
        dispatcher,
        connections,
        frames: [
          ...LIFECYCLE_FRAMES,
          ...TRANSPORT_FRAMES,
          ...PREFERENCES_FRAMES,
          ...SET_CLAUDE_HOOKS_FRAMES,
          ...RESET_FRAMES,
          ...BOARD_FRAMES,
          ...LEDGER_FRAMES,
          ...CONVERSATION_READ_FRAMES,
          ...ATTENTION_FRAMES,
          ...ASKING_FRAMES
        ],
        // Loaded on the first Windows bind only; a Unix socket never needs it.
        ownerOnlyPipe: createNativeOwnerOnlyPipe({ prebuildsDir: winPipePrebuildsDir(appRoot) }),
        sections: () => sections.names(),
        conditions: () => opened.capabilities(),
        identityFile
      })
      // The Host's only exit besides a crash and a refused or failed boot (ADR-002 D7).
      cleanExit = composeHostLifecycle({
        checkpoint: opened.checkpoint,
        connections,
        endpoint,
        identityFile,
        scheduler,
        log,
        sessionEnd: nodeOsSessionSignals(log),
        // No event is routed into the asking module once the Host is closing (ISSUE-140).
        stopRoutes: () => modules.asking?.stop(),
        exit
      })
      return createBootSteps({
        paths: dataDir,
        clock,
        scheduler,
        ids,
        fs,
        processControl,
        log,
        endpoint,
        database: opened,
        // Step 3: preferences first, then the saga's boot resume (07 S13.08).
        resumeResetSaga: async () => {
          const { db, transactions } = opened.connection()
          bus = new InProcessEventBus<HostEvent>({
            transactionScope: transactions,
            onHandlerError: (failure) =>
              log.record({
                level: 'error',
                event: 'uncaught',
                subsystem: 'host',
                errCode: errorCode(failure.error)
              })
          })
          ledgerRepository = new SqliteLedgerRepository({ db, scope: transactions, ids, clock })
          resetSteps = createModuleResetSteps({
            db,
            scope: transactions,
            clock,
            mapSites,
            random: Math.random
          })
          // Cut 2 (ISSUE-323): the one writer of DwarfAI's entries in other tools' configs (16 §7),
          // with the Claude Code hooks target; the hook entry carries the ingress's persisted port.
          const ingressPort = appMetaIngressPort(db)
          configWriter = new ConfigWriterEngine({
            fs,
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
                path: claudeSettingsPathHere(),
                platform: hostRuntime().os as NodeJS.Platform,
                ingressPort: persistedIngressPort(ingressPort)
              })
            ]
          })
          const preferences = servedPreferences.wire({
            db,
            transactions,
            bus,
            clock,
            ids,
            hostEpoch: epoch,
            log,
            featureFlags: await createFeatureFlagReader({
              env: process.env,
              fs,
              configFilePath: featureFlagConfigFilePath(dataDir.userDataDir),
              log
            }),
            maintenance: new SqliteResetCleanup({
              db,
              path: join(dataDir.userDataDir, HOST_DB_FILE)
            }),
            // `LedgerRepository.setInstallMoment` (16 §4.10) and the cut-1 module steps (ISSUE-121).
            ledger: ledgerRepository,
            moduleSteps: resetSteps.steps,
            // No OS secret store yet (later: ISSUE-324).
            secrets: unavailableSecretStore,
            externalConfig: hostConfigWriter({ claudeHooks: configWriter, ingressPort, log }),
            // The hashes the hook ingress's lookup reads (WiredPreferences.channelTokens).
            channelTokens: new SqliteChannelTokenStore({ db, ids }),
            // The first-run step's installed tools: suppliers' detection cache, once step 4 wired
            // suppliers (nothing installed before; the step is evaluated in step 8, ISSUE-222).
            // Only the tools whose integration can be turned on now are offered (hidden until
            // built): Claude Code once the hook ingress persisted its port (ISSUE-323).
            installedTools: enablableInstalledTools(
              suppliersInstalledTools(() => modules.suppliers?.catalogue ?? null),
              ingressPort
            ),
            // The token issuance of the transport (lead decision 2026-09-30, ISSUE-198): the
            // Claude hook token is minted here, never in the module (R3).
            mintCredential,
            ready: () => hostState.current().state === 'ready'
          })
          modules.preferences = preferences
          return preferences.resumeOnBoot()
        },
        // Step 3, after the resume: every write a crash left between Tx A and Tx B (07 S14.11).
        reverifyConfigWrites: () => {
          if (configWriter === undefined) {
            throw new HostInvariantError('the config writer is built before its boot settlement')
          }
          return configWriter.settleUnverified()
        },
        constructModules: () => {
          const { db, transactions } = opened.connection()
          if (
            bus === undefined ||
            modules.preferences === undefined ||
            ledgerRepository === undefined ||
            resetSteps === undefined
          ) {
            throw new HostInvariantError('boot step 4 runs after step 3 wired preferences')
          }
          modules.suppliers = wireSuppliers({
            publicBuild: isPublicBuild(buildKindOf(dataDir)),
            clock,
            scheduler,
            ids,
            fs,
            log,
            installResolver: createHostInstallResolver({ fs, processControl, scheduler }),
            capabilityRecords: new SqliteCapabilityRecordStore({
              db,
              tx: transactions,
              ids,
              log
            }),
            integrationGate: modules.preferences.integrationGate,
            bus,
            hostEpoch: epoch,
            // A new demo world each Host start (15 §4.12); development builds only.
            simulatedSeed: epoch
          })
          // The providers' own folders: the environment overrides they honour, else the person's
          // home folder (15 §5; HO-09). Read only, by observation and by the coal backfill.
          const folders = observedProviderFolders(process.env, homedir(), {
            settings: hostSettings,
            onInvalid: (key) =>
              log.record({
                level: 'warn',
                event: CLAUDE_CONFIG_DIRS_INVALID_EVENT,
                subsystem: 'observation',
                outcome: 'degraded',
                causeClass: key,
                msg: 'invalid Claude configuration roots; the default root applies'
              })
          })
          // The ledger first: observation's batch sink holds its half and the mines' section and
          // frames read its totals.
          const ledger = wireLedger({
            repository: ledgerRepository,
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
                claudeRoots: folders.claudeConfigDirs,
                codexHome: folders.codexHome,
                opencodeStoreRoot: folders.openCodeStoreRoot,
                resolveMine
              })
          })
          modules.ledger = ledger
          // The kernel LifecycleFactLog: one SQLite adapter, shared by crew and conversation (05 §4).
          const lifecycleFacts = new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock })
          // Conversation next: the bridge holds its half; its frames are routed once crew exists.
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
          modules.conversation = conversation
          // The ObservedBatchSink bridge: conversation's half (the messages), the ledger's (the usage).
          const batches = composeObservedBatchSink({
            transactions,
            ledger: ledger.batchHalf,
            conversation: conversation.batchHalf
          })
          // A cut-1 rollback build (21 §2 cut 1 row "Rollback") wires observation over a sink that writes
          // nothing, so it is never started and the coal backfill never runs (wiring/cut1Rollback.ts).
          modules.batchSink = CUT_1_ROLLBACK_CHOICES.observedBatchSink(batches.sink)
          // The four observation adapters: observation reads through them, and the cut-1 turn-end
          // route reads each session's declared `turnEnd` capability from them (ADR-009 D3).
          const observed = observationAdapters({
            folders,
            fs,
            clock,
            processes: processControl,
            openSnapshot: openReadOnlySnapshot
          })
          // Observation next: crew's terminator and index read it, and every route that reads its
          // events is subscribed here, before step 7's catch-up (16 §8.2).
          modules.observation = wireObservation({
            // One set of the module's stores: crew's `ProviderIdentity → DwarfId` reads share it.
            stores: createSqliteObservationStores({ db, scope: transactions, clock }),
            ...observed,
            // Owner decision 2026-10-10: no session arrives for history before the install moment.
            installMoment: () => ledgerRepository?.installMoment() ?? null,
            sink: modules.batchSink,
            transactions: batches.transactions,
            bus,
            fs,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch,
            log
          })
          modules.crew = servedCrew.wire({
            db,
            transactions,
            lifecycleFacts,
            bus,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch,
            log,
            // No launch and no delivery route reach the Host yet (later: EPIC-10).
            links: { owned: () => false, hasDeliveryRoute: () => false },
            processes: processControl,
            observation: modules.observation.crew,
            // The `dwarfs` section's stored outcome lines (owner amendment E).
            outcomes: conversation.conversation.queries
          })
          modules.mines = servedMines.wire({
            db,
            transactions,
            bus,
            clock,
            scheduler,
            ids,
            fs,
            hostEpoch: epoch,
            log,
            mapSites,
            random: Math.random,
            scanner: new FsSourceWeightScanner(),
            ...DEFAULT_MINES_SETTINGS,
            crew: modules.crew.mines,
            ledger: ledger.totals,
            // The board frames' stored outcome lines (owner amendment E).
            outcomes: conversation.conversation.queries
          })
          // The Reset saga's walks of the mines its step recreated (moduleResetSteps.ts).
          resetSteps.route({ bus, walks: modules.mines.walks })
          modules.crew.route({
            commands: modules.mines.mines.commands,
            queries: modules.mines.mines.queries
          })
          ledger.route({ mines: modules.mines.mines.queries })
          conversation.route({
            crew: modules.crew.crew.queries,
            mines: modules.mines.mines.queries
          })
          // O-11-10: a mine created or reattached later is paid its pre-install usage as coal; not
          // in a cut-1 rollback build (the gate of step 7 and of the coal backfill).
          routeMineBackfillWhenObserving(ledger, bus, modules.batchSink)
          // 08 §2.9: the end of a Reset metrics credits the units held during it, then restarts the
          // backfill behind the same gate (ISSUE-121).
          routeResetFinished(ledger, bus, modules.batchSink)
          // Attention, whose inputs the cut-1 routes below feed.
          modules.attention = servedAttention.wire({
            ledger: new SqliteAttentionLedger({ db, scope: transactions, clock, hostEpoch: epoch }),
            // A cut-1 rollback build sends no level-3 notification: the legacy notifier is the one notifier
            // (21 §2 cut 1 row "Rollback"; wiring/cut1Rollback.ts).
            sink: CUT_1_ROLLBACK_CHOICES.level3Sink(new TransportLevel3Sink(connections), log),
            launcher: new AppBackgroundNotifierLauncher({
              processes: processControl,
              paths: dataDir,
              // A development build's executable is Electron itself: it needs the app folder.
              appArgs: dataDir.isPackaged ? [] : [appRoot],
              env: process.env,
              scheduler,
              onNotifierAttach: onNotifierAttach(connections)
            }),
            preferences: modules.preferences.preferences.queries,
            transactions,
            bus,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch,
            log
          })
          // Asking (ISSUE-140: wiring/routes/askingRoutes.ts), once suppliers, conversation,
          // observation, crew, mines and attention exist, and ahead of the cut-1 routes, so a
          // departure closes the dwarf's asks before conversation records its session end. The
          // hook ingress route is built here; listening on it and persisting its port is boot
          // step 6's (later: ISSUE-209).
          if (modules.suppliers === undefined) {
            throw new HostInvariantError('asking is wired after suppliers')
          }
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
            claudeProviderId: 'claude' as ProviderId,
            suppliers: modules.suppliers,
            observed: observed.adapters,
            conversation: conversation.conversation,
            crew: modules.crew.crew,
            mines: modules.mines.mines.queries,
            attention: modules.attention.attention,
            observation: {
              sessions: modules.observation.crew.sessions,
              control: { nudge: (hint) => modules.observation?.nudge(hint) }
            },
            preferences: {
              queries: modules.preferences.preferences.queries,
              channelTokens: modules.preferences.channelTokens
            },
            keystrokes: {
              // No relay into an observed terminal yet (later: ISSUE-167): nothing is pressed.
              relay: NO_KEYSTROKE_RELAY,
              transcripts: new FsTranscriptTail(fs),
              redact: redactSecrets
            }
          }
          modules.asking = servedAsking.wire(askingDeps)
          // The cut-1 cross-epic routes (ISSUE-120), once every cut-1 module exists (16 §8.2 step 4):
          // observed turn ends into conversation, `TurnEnded` into crew and attention, the next turn
          // start and `DwarfDeparted` withdrawing attention keys, `DwarfDeparted` into conversation.
          routeCut1Events({
            bus,
            observed: observed.adapters,
            sessions: modules.observation.crew.sessions,
            conversation: conversation.conversation.commands,
            crew: modules.crew.crew,
            mines: modules.mines.mines.queries,
            attention: modules.attention.attention
          })
        },
        // Step 7: the catch-up, then the live loop, through the wiring's own `start`, which is null
        // in a cut-1 rollback build (and over any sink that stores nothing, INV-98).
        startObservation: () => modules.observation?.start?.(),
        startModules: () => modules.mines?.start(),
        // Step 8, before `ready`: the first-run consent step, right after the start-up installed
        // detection (07 S41.01, S41.09; ISSUE-222).
        evaluateWelcome: () => {
          const { preferences, suppliers } = modules
          if (preferences === undefined || suppliers === undefined) {
            throw new HostInvariantError('boot step 8 runs after steps 3 and 4 wired the modules')
          }
          return evaluateWelcomeAfterDetection({
            detection: suppliers.bootDetection,
            evaluate: () => preferences.evaluateWelcomeAtBoot(),
            log
          })
        }
      })
    },
    {
      log,
      clock,
      state: hostState,
      privilege,
      paths,
      runtime: hostRuntime(),
      exit
    }
  )
  // Once the Host answers `ready`: the coal backfill (07 S19.02, S19.04), behind the same gate as
  // observation (a cut-1 rollback build runs neither). A mine first seen after it finished is paid
  // by the per-mine run routed at step 4 (O-11-10).
  if (booted.kind === 'ready' && modules.ledger !== undefined && modules.batchSink !== undefined) {
    void startBackfillWhenObserving(modules.ledger, modules.batchSink)
  }
}

function isInside(folder: string, file: string): boolean {
  const path = relative(folder, file)
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}

void main()
