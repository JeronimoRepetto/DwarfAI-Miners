// The Host's process-wide failure handler (19 §9.1 `uncaught`, §11; ADR-026 item 7; 13 FM-001):
// composition code, installed by the composition root (host/main.ts) as soon as its log exists.
//
// An uncaught exception or an unhandled rejection is written as one `uncaught` `error` record with
// exactly the 19 §9.1 fields: `errCode` (the error's code, else its class name) and the bounded
// `stack` of an Error (the log's pipeline makes it relative and cuts it, ADR-026 item 5; this is
// the only record that carries one). Then the Host follows its failure policy: the record is
// flushed to its segment and the process exits non-zero, so the UI sees a crash (socket EOF, a
// later boot without the clean-shutdown marker, FM-001) and respawns it. Errors that arrive while
// the first one is being flushed are recorded too; the Host exits once.
import type { DiagnosticEntry, DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import { errorCode } from './boot'
import { UNCAUGHT_EXIT_CODE } from './exitCodes'

export { UNCAUGHT_EXIT_CODE }

/** The two process events the handler listens to: `process` in production. */
export interface UncaughtSource {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): unknown
}

export interface UncaughtDeps {
  process: UncaughtSource
  /** The Host's log; `flush` resolves once every accepted record is written or dropped. */
  log: DiagnosticsLog & { flush(): Promise<void> }
  /** Ends the process with `code`. */
  exit(code: number): void
}

export function installUncaughtHandlers(deps: UncaughtDeps): void {
  let exiting = false
  const onError = (error: unknown): void => {
    deps.log.record(uncaughtEntry(error))
    if (exiting) return
    exiting = true
    void deps.log.flush().finally(() => deps.exit(UNCAUGHT_EXIT_CODE))
  }
  deps.process.on('uncaughtException', onError)
  deps.process.on('unhandledRejection', onError)
}

function uncaughtEntry(error: unknown): DiagnosticEntry {
  return {
    level: 'error',
    event: 'uncaught',
    subsystem: 'host',
    errCode: errorCode(error),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {})
  }
}
