// Electron main's process-wide failure handler (19 §9.1 `uncaught`, §11; ADR-026 item 7; 13 FM-041),
// installed by the Electron composition root (ui-main/index.ts) as soon as the UI logger exists.
//
// An uncaught exception or an unhandled rejection is written as one `uncaught` `error` record with
// exactly the 19 §9.1 fields: `errCode` (the error's code when it has the log's identifier shape,
// else its class name, else `unknown`, so the record is never refused) and the bounded `stack` of an
// Error (the logger makes it relative and cuts it, ADR-026 item 5; the only record that carries
// one). Then Electron main follows its failure policy (19 §11): the record is flushed to its segment
// and the process exits non-zero. A listener on `uncaughtException` is also what keeps Electron from
// showing its own "A JavaScript error occurred in the main process" dialog: no modal ever opens.
// Errors that arrive while the first one is being flushed are recorded too; the process exits once.
import type { UiLog, UiLogEntry } from './uiLogger'

/** Electron main's exit after a logged uncaught error: the code Node itself uses for one. */
export const UI_UNCAUGHT_EXIT_CODE = 1

/** The two process events the handler listens to: `process` in production. */
export interface UiUncaughtSource {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): unknown
}

export interface UiUncaughtDeps {
  process: UiUncaughtSource
  /** The UI logger; `flush` resolves once every accepted record is written or dropped. */
  log: UiLog & { flush(): Promise<void> }
  /** Ends the process with `code` (`app.exit`). */
  exit(code: number): void
}

/** The identifier shape the UI writer accepts for `errCode` (uiRecordRules.ts). */
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/

export function installUiUncaughtHandlers(deps: UiUncaughtDeps): void {
  let exiting = false
  const onError = (error: unknown): void => {
    deps.log.record(uncaughtEntry(error))
    if (exiting) return
    exiting = true
    void deps.log.flush().finally(() => deps.exit(UI_UNCAUGHT_EXIT_CODE))
  }
  deps.process.on('uncaughtException', onError)
  deps.process.on('unhandledRejection', onError)
}

function uncaughtEntry(error: unknown): UiLogEntry {
  const code = (error as { code?: unknown } | null)?.code
  const name = error instanceof Error ? error.name : undefined
  const errCode = [code, name].find(
    (value): value is string => typeof value === 'string' && ERROR_CODE.test(value)
  )
  return {
    level: 'error',
    event: 'uncaught',
    subsystem: 'ui-main',
    errCode: errCode ?? 'unknown',
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {})
  }
}
