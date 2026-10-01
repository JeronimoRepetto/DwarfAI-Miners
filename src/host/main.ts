// The DwarfAI Host's composition root (16 §8.1, 05 §2.3; ADR-002 D1): the only file that builds
// the platform adapters and kernel ports, which it hands to the boot (host/wiring/boot.ts) and its
// steps (host/wiring/bootSteps.ts). It runs from the app's own executable with
// ELECTRON_RUN_AS_NODE=1 (kept by SP-04), built to `out/host/main.js` by
// electron.vite.host.config.ts, and never imports `electron` (R7) or the UI trees (R10).
//
// It arms no parent-death watchdog and no idle timer: the Host never exits on its own (ADR-002 D1,
// D7; OQ-63). It exits only through the boot's `exit`, for a refusal (ALREADY_RUNNING,
// ELEVATED_REFUSED, NO_DATA_DIR) or a failed boot. What keeps the process running after `ready` is
// the UI endpoint the bind step listens on (later: ISSUE-022); until that step is built nothing
// holds the event loop, and nothing ends it either.
//
// Bound later, each by its issue: the HostStateSink (ISSUE-028), the database (ISSUE-039), the
// modules and their bridges (16 §8.2 step 4).
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDiagnostics, logLevelFromEnv, type HostDiagnostics } from './modules/diagnostics'
import { NodeScheduler } from './platform/clock/NodeScheduler'
import { SystemClock } from './platform/clock/SystemClock'
import { NodeFs } from './platform/fs/NodeFs'
import { UuidV7Generator } from './platform/ids/UuidV7Generator'
import { EnvAppPaths } from './platform/paths/EnvAppPaths'
import { NodeProcessControl, createQueryRunner } from './platform/process/NodeProcessControl'
import { createPrivilegeCheck } from './platform/process/privilege'
import { hostRuntime } from './platform/process/runtimeFacts'
import { errorCode, runBoot, type HostStateSink } from './wiring/boot'
import { createBootSteps } from './wiring/bootSteps'

/** The app's version, stamped by electron.vite.host.config.ts from package.json. */
declare const __DWARFAI_APP_VERSION__: string

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

/** Until transport holds the lifecycle state (later: ISSUE-028), nobody listens to it. */
const NO_STATE_LISTENER: HostStateSink = { report: () => {} }

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
  const runQuery = createQueryRunner()
  const processControl = new NodeProcessControl({
    scheduler,
    diagnostics: log,
    runCommand: runQuery
  })

  await runBoot(
    (dataDir) =>
      createBootSteps({ paths: dataDir, clock, scheduler, ids, fs, processControl, log }),
    {
      log,
      clock,
      state: NO_STATE_LISTENER,
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
