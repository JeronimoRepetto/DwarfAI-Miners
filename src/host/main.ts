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
// the Reset saga's cleanup and the cut-1 bindings that stand in for the OS secret store, the config
// writers and the ledger) and resumes an unfinished Reset saga before anything else is constructed
// and before any command is accepted (05 §2.3; 16 §8.2). Boot step 4 constructs the other modules,
// each wired by its issue: suppliers (ISSUE-159) with the one CliInstallResolver, the
// SqliteCapabilityRecordStore, the Host's event bus and the integration gate bridge to preferences;
// the ledger (ISSUE-096: wiring/routes/ledger.ts) over the SqliteLedgerRepository and the coal
// backfill's ProviderHistoryScanner (its folders folded by the mines' git inspector), with its
// `ledger.changed` frame and its `MineMeasured` → `creditSealedUnits` route; observation (ISSUE-095:
// wiring/routes/observation.ts) over its three SQLite stores, the Claude, Codex, Antigravity and
// OpenCode adapters reading the providers' own folders (read only; SQLite files through the
// read-only snapshot), its provider-error route to diagnostics and the ObservedBatchSink bridge
// (wiring/bridges/observedBatchSink.ts) with the ledger's half only (conversation's: later:
// ISSUE-108); crew (ISSUE-094: wiring/routes/crew.ts) with the
// one SqliteLifecycleFactLog (shared with conversation, later: ISSUE-099), the SessionTerminator
// bridge over the kernel's process control and observation's process identities and
// `recordEnded`, its identity index over observation's stores, and its `dwarfs` section and B-M41
// served before the bind; mines (ISSUE-093: wiring/routes/mines.ts) over crew's ends and queries,
// with the FsSourceWeightScanner of its scoring walks, its seam-B members (B-M16…B-M20) and
// `mines` section served before the bind, its board frames (the provider-error toast among them)
// and the provider-error route to `checkFolder`, reading each mine's totals from the ledger; then
// crew's observation routes, the boot recompute of the dwarf statuses from their persisted facts
// (S1.18) and the ledger's backfill folder resolution over the mines' queries; attention (ISSUE-119:
// wiring/routes/attentionTransport.ts) over the SqliteAttentionLedger, the TransportLevel3Sink, the
// AppBackgroundNotifierLauncher (this executable `--background`, after the app folder in a
// development build) and the `AttentionSettings` bridge to preferences, with B-M07 `presence` and
// B-M08 `attention.clicked` served before the bind, the attention frames advertised, and the
// connection registry feeding the presence union and the tray notifier supervisor. The others join
// later. Observation is composed but not started: step 7 stays a placeholder while the bridge's
// sink is (ISSUE-108). After step 7 (`startModules`) the mines restart the walks a stopped Host
// left and start their folder-check schedule. The coal backfill, after `ready`, is held off with
// observation (ISSUE-108 turns both on). A cut-1 rollback build (wiring/cut1Rollback.ts, ISSUE-122) wires
// observation over a sink that writes nothing, so neither ever runs, and attention over a level-3 sink that
// delivers nothing: the legacy observer, ledger and notifier are the one observer, ledger and notifier again.
import { homedir } from 'node:os'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@dwarfai/contracts'
import { AppBackgroundNotifierLauncher } from './modules/attention/adapters/AppBackgroundNotifierLauncher'
import { SqliteAttentionLedger } from './modules/attention/adapters/SqliteAttentionLedger'
import { createDiagnostics, logLevelFromEnv } from './modules/diagnostics'
import { ProviderHistoryScanner } from './modules/ledger/adapters/ProviderHistoryScanner'
import { SqliteLedgerRepository } from './modules/ledger/adapters/SqliteLedgerRepository'
import { createHostGitRepoInspector } from './modules/mines/adapters/FsGitRepoInspector'
import { FsSourceWeightScanner } from './modules/mines/adapters/FsSourceWeightScanner'
import type { PreferencesEvent } from './modules/preferences'
import type { Suppliers, SuppliersEvent } from './modules/suppliers'
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
import { ConnectionRegistry } from './transport/connectionRegistry'
import { TRANSPORT_FRAMES } from './transport/events/framePublisher'
import { BOARD_FRAMES } from './transport/frames/board'
import { LEDGER_FRAMES } from './transport/frames/ledger'
import { createUpgradeDrain } from './transport/lifecycle/drain'
import { HostStateHolder, LIFECYCLE_FRAMES } from './transport/lifecycle/hostState'
import { createUpgradeTargetRule } from './transport/methods/hostUpgradeRequest'
import { PREFERENCES_FRAMES } from './transport/methods/preferences'
import { RESET_FRAMES } from './transport/methods/resetMetrics'
import { HostIdentityFile } from './transport/runFiles/hostIdentityFile'
import { SNAPSHOT_TAIL, type SnapshotMetaSource } from './transport/snapshot/metaSection'
import { SectionRegistry } from './transport/snapshot/sectionRegistry'
import { NodeRunFileWriter } from './transport/runFiles/nodeRunFileWriter'
import { errorCode, runBoot } from './wiring/boot'
import { createHostDispatcher } from './wiring/hostDispatcher'
import { createBootSteps, createUiEndpoint, mintBootEpoch } from './wiring/bootSteps'
import { composeObservedBatchSink } from './wiring/bridges/observedBatchSink'
import { CUT_1_ROLLBACK_CHOICES } from './wiring/cut1Rollback'
import { createFeatureFlagReader, featureFlagConfigFilePath } from './wiring/featureFlagReader'
import { createHostDatabase, HOST_DB_FILE, type HostDatabase } from './wiring/hostDatabase'
import { composeHostLifecycle } from './wiring/hostLifecycle'
import { installUncaughtHandlers } from './wiring/uncaught'
import { emptyDrainGate } from './wiring/emptyDrainGate'
import { emptyOwnerStopAll } from './wiring/emptyOwnerStopAll'
import {
  emptyLedgerInstallMoment,
  noOwnedConfigWriter,
  servePreferences,
  unavailableSecretStore,
  type WiredPreferences
} from './wiring/preferencesWiring'
import {
  ATTENTION_FRAMES,
  onNotifierAttach,
  serveAttention,
  type AttentionRouteEvent,
  type WiredAttention
} from './wiring/routes/attentionTransport'
import { serveCrew, type CrewRouteEvent, type WiredCrew } from './wiring/routes/crew'
import {
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
  observationAdapters,
  observedProviderFolders,
  wireObservation,
  type WiredObservation
} from './wiring/routes/observation'
import { isPublicBuild, wireSuppliers } from './wiring/suppliersWiring'
import { HostInvariantError, InProcessEventBus } from './kernel'
import type { CleanExit } from './transport/lifecycle/cleanExit'

/** Every event the Host's one bus carries so far. */
type HostEvent =
  | PreferencesEvent
  | SuppliersEvent
  | MinesRouteEvent
  | CrewRouteEvent
  | LedgerRouteEvent
  | AttentionRouteEvent

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
    suppliers?: Suppliers
    ledger?: WiredLedger
    /** Observation's batch sink: the placeholder until the conversation half (ISSUE-108). */
    batchSink?: ObservedBatchSink
    observation?: WiredObservation
    crew?: WiredCrew
    mines?: WiredMines
    attention?: WiredAttention
  } = {}
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
          ...RESET_FRAMES,
          ...BOARD_FRAMES,
          ...LEDGER_FRAMES,
          ...ATTENTION_FRAMES
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
            // Cut 1: no ledger install-moment writer (`LedgerRepository.setInstallMoment`, later:
            // ISSUE-097), OS secret store or owned config entry yet (later: ISSUE-324, ISSUE-323).
            ledger: emptyLedgerInstallMoment,
            secrets: unavailableSecretStore,
            externalConfig: noOwnedConfigWriter,
            ready: () => hostState.current().state === 'ready'
          })
          modules.preferences = preferences
          return preferences.resumeOnBoot()
        },
        constructModules: () => {
          const { db, transactions } = opened.connection()
          if (bus === undefined || modules.preferences === undefined) {
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
          const folders = observedProviderFolders(process.env, homedir())
          // The ledger first: observation's batch sink holds its half and the mines' section and
          // frames read its totals.
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
          modules.ledger = ledger
          // The ObservedBatchSink bridge: the ledger's half; conversation's is not wired yet
          // (later: ISSUE-108), so the sink stays the placeholder and observation is not started.
          const batches = composeObservedBatchSink({
            transactions,
            ledger: ledger.batchHalf,
            conversation: null
          })
          // A cut-1 rollback build (21 §2 cut 1 row "Rollback") wires observation over a sink that writes
          // nothing, so it is never started and the coal backfill never runs (wiring/cut1Rollback.ts).
          modules.batchSink = CUT_1_ROLLBACK_CHOICES.observedBatchSink(batches.sink)
          // Observation next: crew's terminator and index read it, and every route that reads its
          // events is subscribed here, before step 7's catch-up (16 §8.2).
          modules.observation = wireObservation({
            // One set of the module's stores: crew's `ProviderIdentity → DwarfId` reads share it.
            stores: createSqliteObservationStores({ db, scope: transactions, clock }),
            ...observationAdapters({
              folders,
              fs,
              clock,
              processes: processControl,
              openSnapshot: openReadOnlySnapshot
            }),
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
          // The kernel LifecycleFactLog: one SQLite adapter, shared by crew and conversation (05 §4).
          const lifecycleFacts = new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock })
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
            observation: modules.observation.crew
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
            // No spawn-site table reaches the Host yet: no site is stored, and the map places each
            // marker itself (chooseMapSite's documented fallback).
            mapSites: [],
            random: Math.random,
            scanner: new FsSourceWeightScanner(),
            ...DEFAULT_MINES_SETTINGS,
            crew: modules.crew.mines,
            ledger: ledger.totals
          })
          modules.crew.route({
            commands: modules.mines.mines.commands,
            queries: modules.mines.mines.queries
          })
          ledger.route({ mines: modules.mines.mines.queries })
          // Attention: its routes from the other modules' events join with ISSUE-120.
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
        },
        // Step 7 (`startObservation`: catch-up, then the live loop) is not passed: until the
        // bridge has its conversation half the batch sink is the placeholder, a running loop
        // would move every cursor past messages nothing stores, lost for good (INV-98), and
        // `WiredObservation.start` is null with it. ISSUE-108 turns observation on here.
        startModules: () => modules.mines?.start()
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
  // Once the Host answers `ready`: the coal backfill (07 S19.02, S19.04), held off with
  // observation while the batch sink is the placeholder. It pays only folders that are already
  // mines, so a run before observation creates any would end `done` with nothing paid, for good.
  // ISSUE-108 turns it on together with observation; what a mine first seen after the backfill
  // finished receives is O-11-10's ruling (owner).
  if (booted.kind === 'ready' && modules.ledger !== undefined && modules.batchSink !== undefined) {
    void startBackfillWhenObserving(modules.ledger, modules.batchSink)
  }
}

function isInside(folder: string, file: string): boolean {
  const path = relative(folder, file)
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}

void main()
