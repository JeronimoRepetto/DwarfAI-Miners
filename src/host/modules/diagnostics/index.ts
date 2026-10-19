// The diagnostics module (05 §3.13): ADR-026's local rotating log for the Host. Every Host module logs
// through the kernel `DiagnosticsLog` this returns; the Host's segments are `host-<seq>.jsonl` in the
// shared `logs/` folder, pruned with the UI's and shims' segments to 100 000 000 bytes in all. No
// network, no telemetry and no in-app way to open or export the log (ADR-026 items 7–8).
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { FileSystem } from '../../kernel/ports/fileSystem'
import { FsLogDirectory } from './adapters/FsLogDirectory'
import {
  HostDiagnosticsLog,
  logLevelFromEnv,
  type HostLogLevel
} from './adapters/HostDiagnosticsLog'

export { logLevelFromEnv, type HostLogLevel }

/**
 * The Host's log as the composition root holds it: the kernel `DiagnosticsLog` every module gets,
 * plus `flush`, which resolves once every record accepted so far is written or dropped (never
 * rejects), so a Host that must exit can let its last records reach the segment first.
 */
export interface HostDiagnostics extends DiagnosticsLog {
  flush(): Promise<void>
}

export interface DiagnosticsDeps {
  readonly fs: FileSystem
  readonly clock: Clock
  /**
   * `<userData>/logs/` (ADR-026 item 1): `path.join(path.dirname(appPaths.userDataDir), 'logs')`,
   * computed once by the composition root (`AppPaths.userDataDir` is `<userData>/host`).
   */
  readonly logDir: string
  /** The app's version, as the build stamps it (`LogRecord.appVersion`). */
  readonly appVersion: string
  /** From `logLevelFromEnv(process.env)` at start (19 §6). */
  readonly level: HostLogLevel
  /** The app root that `stack` frames are made relative to (ADR-026 item 5); frames outside it are dropped. */
  readonly appRoot?: string
}

/** Throws `HostInvariantError` when `appVersion` is not a build version (a composition defect). */
export function createDiagnostics(deps: DiagnosticsDeps): HostDiagnostics {
  return new HostDiagnosticsLog({
    fs: deps.fs,
    directory: new FsLogDirectory(deps.logDir),
    logDir: deps.logDir,
    clock: deps.clock,
    appVersion: deps.appVersion,
    level: deps.level,
    pid: process.pid,
    ...(deps.appRoot === undefined ? {} : { appRoot: deps.appRoot })
  })
}
