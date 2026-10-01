// B-M05 `host.shutdown` (14 §2.3, §3.4, §1.7; ADR-002 D7; ADR-003 item 12, frozen; AMENDMENT-5):
// the Host half of the tray's Stop everything and quit (UC-023). Only a `ui` connection may send
// it (roles.ts; a `notifier` gets FORBIDDEN, INV-122); it is mutating, so a repeated `requestId`
// gets the first answer and causes no second stop-all (ADR-003 item 6).
//
// - `stop-all`: the StopAllPort ends every owned session and settles once every end settled
//   (S12.11); the answer is `{ mode: 'stop-all', outcome }`. When `failed` is empty the Host
//   closes cleanly with reason `stop-all` (S12.12) — only after that answer was handed to the
//   writer, so the `res` precedes `host.closing` and the close (14 §1.7). When `failed` is not
//   empty the Host keeps running (S12.21; INV-121): it never exits while an owned session it
//   failed to end is alive (ADR-002 D7 step 3).
// - `when-idle`: retired by AMENDMENT-5 (OQ-63), never honoured → INVALID_PARAMS, state unchanged.
// - `upgrade-drain`: INVALID_PARAMS until the drain-and-resume is served (later: ISSUE-032).
//
// The refused modes are the Host's rule, not the wire's: the contract schema keeps the whole
// generation-stable params shape (14 §1.3), and the schema served here narrows it, so the
// dispatcher answers INVALID_PARAMS before anything runs.
//
// `host.stop-all` is logged once the outcome settled (19 §9.1): `count` = the ended sessions,
// `info` / `ok` when none failed, `warn` / `failed` otherwise, plus one `warn` record per failed
// `dwarfId` (S12.21); never anything a person or provider said.
import { HOST_METHOD_SCHEMAS, type HostShutdownResult } from '@dwarfai/contracts'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { StopAllPort } from '../../kernel/ports/stopAll'
import type { Dispatcher } from '../dispatcher'
import type { CleanExit } from '../lifecycle/cleanExit'
import { METHOD_ROLES } from '../roles'

export interface HostShutdownDeps {
  stopAll: StopAllPort
  lifecycle: CleanExit
  log: DiagnosticsLog
}

/** The modes this Host serves: `stop-all` only (`upgrade-drain`: later: ISSUE-032). */
const SERVED_MODES: ReadonlySet<string> = new Set(['stop-all'])

const paramsSchema = HOST_METHOD_SCHEMAS['host.shutdown'].params.refine((params) =>
  SERVED_MODES.has(params.mode)
)

/** Serves `host.shutdown` on `dispatcher`. */
export function registerHostShutdown(dispatcher: Dispatcher, deps: HostShutdownDeps): void {
  dispatcher.registerMutating(
    'host.shutdown',
    paramsSchema,
    METHOD_ROLES['host.shutdown'] ?? [],
    async (_params, context): Promise<HostShutdownResult> => {
      const outcome = await deps.stopAll.stopAll(context.requestId)
      const complete = outcome.failed.length === 0
      deps.log.record({
        level: complete ? 'info' : 'warn',
        event: 'host.stop-all',
        subsystem: 'host',
        outcome: complete ? 'ok' : 'failed',
        count: outcome.ended.length,
        requestId: context.requestId
      })
      for (const dwarfId of outcome.failed) {
        deps.log.record({
          level: 'warn',
          event: 'host.stop-all',
          subsystem: 'host',
          outcome: 'failed',
          dwarfId,
          requestId: context.requestId
        })
      }
      // A checkpoint that throws rejects closeCleanly before any host.closing: the Host then dies
      // as a crash, never as a clean exit that was not (cleanExit.ts).
      if (complete) context.afterAnswer(() => void deps.lifecycle.closeCleanly('stop-all'))
      return { mode: 'stop-all', outcome }
    }
  )
}
