// closeCleanly(reason) (ADR-002 D7; ADR-003 item 12, frozen; 07 S12.10, S12.16, S12.17; 14 B-F05):
// the Host's only exit path besides a crash. Nothing calls it on a timer: the Host never exits on
// its own (OQ-63; AMENDMENT-5 retired the idle exit and `when-idle`). In order:
//
// 1. the checkpoint (`checkpointing`): flush the database, then record the clean-shutdown marker
//    with its reason (ShutdownCheckpoint; the `app_meta` writer is ISSUE-039's);
// 2. `host.closing {reason, clean: true}` on every `ui` and `notifier` connection (B-F05), so the
//    tray process leaves with the Host instead of reconnecting (FM-006: a crash sends none); a
//    `viewer` gets no frame and sees its connection close;
// 3. every connection ended, the frames written first, bounded by CLOSING_FLUSH_BOUND_MS;
// 4. the endpoint closed: it stops listening and removes the POSIX socket file (ADR-002 D7);
// 5. `host.exit` logged with the reason as its class (19 §9.1), then exit 0 (S12.17, `exited`).
//
// The first call is the exit: a later call, whatever its reason, joins it. A reason outside
// CLEAN_EXIT_REASONS — the retired `'idle'` above all — is a programming error: refused before
// anything runs, so it is never written, sent or logged. A checkpoint that throws stops the exit
// before any `host.closing`, so the clients see a crash, never a clean exit that was not.
import { HostInvariantError } from '../../kernel/domain/errors'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { CleanShutdownReason, ShutdownCheckpoint } from '../../kernel/ports/shutdownCheckpoint'
import type { ConnectionRegistry } from '../connectionRegistry'

/** The reasons a clean exit may carry: never the retired `'idle'` (AMENDMENT-5). */
export const CLEAN_EXIT_REASONS: readonly CleanShutdownReason[] = Object.freeze([
  'stop-all',
  'upgrade',
  'os-session-end'
])

/**
 * How long the connections get to take `host.closing` before the endpoint closes what is left.
 * The package names no bound; a local pipe or socket hands a small frame over at once, so 1 s only
 * matters for a stalled client, which must not hold the Host's exit.
 */
export const CLOSING_FLUSH_BOUND_MS = 1_000

export interface CleanExitDeps {
  checkpoint: ShutdownCheckpoint
  connections: ConnectionRegistry
  /** The UI endpoint: closing it stops listening and removes the POSIX socket file. */
  endpoint: { close(): Promise<void> }
  scheduler: Scheduler
  log: DiagnosticsLog
  /** Ends the process with `code`. */
  exit(code: number): void
}

export interface CleanExit {
  closeCleanly(reason: CleanShutdownReason): Promise<void>
}

export function createCleanExit(deps: CleanExitDeps): CleanExit {
  let running: Promise<void> | null = null

  const run = async (reason: CleanShutdownReason): Promise<void> => {
    deps.checkpoint.flush()
    deps.checkpoint.markClean(reason)
    deps.connections.publish('host.closing', { reason, clean: true })
    await deps.connections.endAll(deps.scheduler, CLOSING_FLUSH_BOUND_MS)
    await deps.endpoint.close()
    deps.log.record({ level: 'info', event: 'host.exit', subsystem: 'host', causeClass: reason })
    deps.exit(0)
  }

  return {
    closeCleanly(reason) {
      if (!CLEAN_EXIT_REASONS.includes(reason)) {
        return Promise.reject(
          new HostInvariantError(`closeCleanly refuses the reason ${String(reason)}`)
        )
      }
      running ??= run(reason)
      return running
    }
  }
}
