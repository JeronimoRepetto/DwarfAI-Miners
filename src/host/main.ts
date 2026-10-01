// The DwarfAI Host's composition root (16 §8.1, 05 §2.3; ADR-002 D1): the only file that builds
// the platform adapters and kernel ports, which it hands to the boot (host/wiring/boot.ts) and its
// steps (host/wiring/bootSteps.ts). It runs from the app's own executable with
// ELECTRON_RUN_AS_NODE=1 (kept by SP-04), built to `out/host/main.js` by
// electron.vite.host.config.ts, and never imports `electron` (R7) or the UI trees (R10).
//
// It arms no parent-death watchdog and no idle timer: the Host never exits on its own (ADR-002 D1,
// D7; OQ-63). It exits only through the boot's `exit`, for a refusal (ALREADY_RUNNING,
// ELEVATED_REFUSED, NO_DATA_DIR) or a failed boot. What keeps the process running after `ready` is
// the UI endpoint the bind step listens on (createUiEndpoint, ISSUE-022).
//
// The boot reports its lifecycle into the transport's HostStateHolder, which `hello.ok` and
// HOST_NOT_READY read (ISSUE-023); the `host.state` frame on top of it is ISSUE-028's. The seam-B
// Dispatcher starts empty: each method joins it with the issue that serves it.
//
// Bound later, each by its issue: the database (ISSUE-039), the modules and their bridges (16 §8.2
// step 4).
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@dwarfai/contracts'
import { createDiagnostics, logLevelFromEnv, type HostDiagnostics } from './modules/diagnostics'
import { NodeScheduler } from './platform/clock/NodeScheduler'
import { SystemClock } from './platform/clock/SystemClock'
import { createNodeEndpointFacts } from './platform/endpoint/nodeEndpointEnv'
import { NodeFs } from './platform/fs/NodeFs'
import { UuidV7Generator } from './platform/ids/UuidV7Generator'
import { EnvAppPaths } from './platform/paths/EnvAppPaths'
import { NodeProcessControl, createQueryRunner } from './platform/process/NodeProcessControl'
import { createPrivilegeCheck } from './platform/process/privilege'
import { hostRuntime } from './platform/process/runtimeFacts'
import { Dispatcher } from './transport/dispatcher'
import { HostStateHolder } from './transport/hostState'
import { errorCode, runBoot } from './wiring/boot'
import { createBootSteps, createUiEndpoint, mintBootEpoch } from './wiring/bootSteps'

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
  const hostState = new HostStateHolder()
  const dispatcher = new Dispatcher({ log, clock, state: () => hostState.current().state })
  const epoch = mintBootEpoch(ids)
  const runQuery = createQueryRunner()
  const processControl = new NodeProcessControl({
    scheduler,
    diagnostics: log,
    runCommand: runQuery
  })

  await runBoot(
    (dataDir) =>
      createBootSteps({
        paths: dataDir,
        clock,
        scheduler,
        ids,
        fs,
        processControl,
        log,
        endpoint: createUiEndpoint({
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
          dispatcher
        })
      }),
    {
      log,
      clock,
      state: hostState,
      privilege: createPrivilegeCheck({ runQuery }),
      paths,
      runtime: hostRuntime(),
      exit: (code) => {
        // The last records reach the segment first; then the Host ends, whatever handles it holds.
        process.exitCode = code
        void log.flush().finally(() => process.exit(code))
      }
    }
  )
}

function isInside(folder: string, file: string): boolean {
  const path = relative(folder, file)
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}

void main()
