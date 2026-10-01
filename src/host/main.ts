// The DwarfAI Host's composition root (16 §8.1, 05 §2.3; ADR-002 D1): the only file that builds
// the platform adapters and kernel ports, which it hands to the boot (host/wiring/boot.ts) and its
// steps (host/wiring/bootSteps.ts). It runs from the app's own executable with
// ELECTRON_RUN_AS_NODE=1 (kept by SP-04), built to `out/host/main.js` by
// electron.vite.host.config.ts, and never imports `electron` (R7) or the UI trees (R10).
//
// It arms no parent-death watchdog and no idle timer: the Host never exits on its own (ADR-002 D1,
// D7; OQ-63; AMENDMENT-5). It exits through the boot's `exit`, for a refusal (ALREADY_RUNNING,
// ELEVATED_REFUSED, NO_DATA_DIR) or a failed boot, and otherwise only through the clean exit
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
// adds `db-read-only` to `hello.ok.capabilities`. Bound later, each by its issue: the modules and
// their bridges (16 §8.2 step 4).
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@dwarfai/contracts'
import { createDiagnostics, logLevelFromEnv, type HostDiagnostics } from './modules/diagnostics'
import { NodeScheduler } from './platform/clock/NodeScheduler'
import { SystemClock } from './platform/clock/SystemClock'
import { createNodeEndpointFacts } from './platform/endpoint/nodeEndpointEnv'
import { createNativeOwnerOnlyDirectory } from './platform/endpoint/win-pipe/nativeOwnerOnlyDirectory'
import {
  createNativeOwnerOnlyPipe,
  winPipePrebuildsDir
} from './platform/endpoint/win-pipe/nativeOwnerOnlyPipe'
import { NodeFs } from './platform/fs/NodeFs'
import { UuidV7Generator } from './platform/ids/UuidV7Generator'
import { EnvAppPaths } from './platform/paths/EnvAppPaths'
import { buildKindOf, thisProcessReleaseHostDataDir } from './platform/paths/releaseDataDir'
import { hostCopyRootFacts } from './platform/paths/versionedCopyRoot'
import { NodeProcessControl, createQueryRunner } from './platform/process/NodeProcessControl'
import { nodeOsSessionSignals } from './platform/process/osSessionSignals'
import { createPrivilegeCheck } from './platform/process/privilege'
import { hostRuntime } from './platform/process/runtimeFacts'
import { createHostFileProtection } from './platform/sqlite/fileProtection'
import { migrationsFor } from './platform/sqlite/migrations'
import { ConnectionRegistry } from './transport/connectionRegistry'
import { TRANSPORT_FRAMES } from './transport/events/framePublisher'
import { createUpgradeDrain } from './transport/lifecycle/drain'
import { HostStateHolder, LIFECYCLE_FRAMES } from './transport/lifecycle/hostState'
import { createUpgradeTargetRule } from './transport/methods/hostUpgradeRequest'
import { HostIdentityFile } from './transport/runFiles/hostIdentityFile'
import { NodeRunFileWriter } from './transport/runFiles/nodeRunFileWriter'
import { errorCode, runBoot } from './wiring/boot'
import { createHostDispatcher } from './wiring/hostDispatcher'
import { createBootSteps, createUiEndpoint, mintBootEpoch } from './wiring/bootSteps'
import { createHostDatabase, HOST_DB_FILE } from './wiring/hostDatabase'
import { composeHostLifecycle } from './wiring/hostLifecycle'
import { emptyDrainGate } from './wiring/emptyDrainGate'
import { emptyOwnerStopAll } from './wiring/emptyOwnerStopAll'
import { HostInvariantError } from './kernel'
import type { CleanExit } from './transport/lifecycle/cleanExit'

/** The app's version, stamped by electron.vite.host.config.ts from package.json. */
declare const __DWARFAI_APP_VERSION__: string
/** The git commit (short) of this build (20 §3.1), stamped by electron.vite.host.config.ts. */
declare const __DWARFAI_BUILD_ID__: string

/**
 * Where the Host logs when DWARFAI_HOST_DATA_DIR is missing: the log folder is `<userData>/logs/`,
 * beside the data directory (ADR-026 item 1), so there is no folder to write to. The boot still
 * records its NO_DATA_DIR reason through it; the UI's launcher logs the exit code on its side
 * (later: ISSUE-030).
 */
const NO_LOG_FOLDER: HostDiagnostics = {
  record: () => {},
  flush: () => Promise.resolve()
}

async function main(): Promise<void> {
  const entry = fileURLToPath(import.meta.url)
  // `out/host/main.js` → the app root (the repository in dev, `app.asar` when packaged).
  const appRoot = dirname(dirname(dirname(entry)))
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  const paths = EnvAppPaths.create({
    env: process.env,
    execPath: process.execPath,
    resourcesPath,
    // Packaged when this entry sits inside the executable's own resources folder (SP-04: under
    // ELECTRON_RUN_AS_NODE `process.resourcesPath` is that folder).
    isPackaged: resourcesPath !== undefined && isInside(resourcesPath, entry)
  })

  const clock = new SystemClock()
  const fs = new NodeFs()
  const log = paths.ok
    ? createDiagnostics({
        fs,
        clock,
        logDir: join(dirname(paths.value.userDataDir), 'logs'),
        appVersion: __DWARFAI_APP_VERSION__,
        level: logLevelFromEnv(process.env),
        appRoot
      })
    : NO_LOG_FOLDER
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
    upgradeTarget: createUpgradeTargetRule(hostCopyRootFacts())
  })
  const runQuery = createQueryRunner()
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

  await runBoot(
    (dataDir) => {
      // Opened by boot step 2; the epoch it keeps is this boot's (mintBootEpoch, one owner).
      const database = createHostDatabase({
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
        frames: [...LIFECYCLE_FRAMES, ...TRANSPORT_FRAMES],
        // Loaded on the first Windows bind only; a Unix socket never needs it.
        ownerOnlyPipe: createNativeOwnerOnlyPipe({ prebuildsDir: winPipePrebuildsDir(appRoot) }),
        conditions: () => database.capabilities(),
        identityFile
      })
      // The Host's only exit besides a crash and a refused or failed boot (ADR-002 D7).
      cleanExit = composeHostLifecycle({
        checkpoint: database.checkpoint,
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
        database
      })
    },
    {
      log,
      clock,
      state: hostState,
      privilege: createPrivilegeCheck({ runQuery }),
      paths,
      runtime: hostRuntime(),
      exit
    }
  )
}

function isInside(folder: string, file: string): boolean {
  const path = relative(folder, file)
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}

void main()
