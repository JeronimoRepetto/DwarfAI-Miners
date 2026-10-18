// A-N10 `retryRecovery` / `host:recovery:retry` and A-N11 `dismissRecovery` / `host:recovery:dismiss` served by their
// `host` handler (14 §2.2 NEW, `host`, owner launching; `RecoveryActionParams` → `IpcResult<Outcome<…, 'no-report'>>`;
// ADR-015 item 5; OQ-41 A, OQ-43; ADR-019 items 7, 8): Retry and Dismiss of the grouped recovery message the window
// shows after a Host restart left sessions unrecovered.
//
// - Main validates the renderer's payload — `{ hostEpoch, requestId }`, the registry's request, the same object as
//   B-M35's and B-M36's params (14 §1.2) — before anything is sent: an invalid payload answers `IpcResult {ok:false,
//   error: INVALID_PARAMS}` and never reaches the Host (ADR-019).
// - A valid payload is relayed as `launching.retryRecovery` (B-M35) or `launching.dismissRecovery` (B-M36) through
//   `HostClient.call` with exactly the parsed params. The Host's outcome — the settled report, `{}`, or `no-report`
//   when that epoch has no unsettled report — is the value. A Host call error is the result's error branch, never a
//   throw into the renderer (14 §1.5).
// - A-N10 and A-N11 are born `host` in 3a and listed in `unrouted.ts` until the step-3a switch (ISSUE-001) routes them
//   here and the root composes this part (22 §5). A call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs.
//
// Candidate decision (21 §6): no candidate exists in UI main; new code on the `stopDwarf.host.ts` pattern.
import {
  CHANNELS,
  type ChannelKey,
  type HostMethod,
  type IpcError,
  type IpcResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-N10 (invoke), by its registry key. */
export const RETRY_RECOVERY = 'host:recovery:retry' satisfies ChannelKey
/** A-N11 (invoke), by its registry key. */
export const DISMISS_RECOVERY = 'host:recovery:dismiss' satisfies ChannelKey
/** The invoke rows this target serves. */
export const RECOVERY_REPORT_ROWS = [RETRY_RECOVERY, DISMISS_RECOVERY] as const

/** The seam-B member each row relays (14 §1.2). */
const MEMBER_OF = {
  [RETRY_RECOVERY]: 'launching.retryRecovery',
  [DISMISS_RECOVERY]: 'launching.dismissRecovery'
} as const satisfies Record<(typeof RECOVERY_REPORT_ROWS)[number], HostMethod>

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the recovery relay failed')
}

function isRecoveryRow(channel: string): channel is (typeof RECOVERY_REPORT_ROWS)[number] {
  return (RECOVERY_REPORT_ROWS as readonly string[]).includes(channel)
}

export function createRecoveryReportRow(client: Pick<HostClient, 'call'>): RouteTarget {
  return {
    serve(channel, payload): Promise<IpcResult<unknown>> {
      if (!isRecoveryRow(channel)) {
        return Promise.resolve({
          ok: false,
          error: callError('METHOD_NOT_FOUND', `no route for ${channel}`)
        })
      }
      const parsed = CHANNELS[channel].request.safeParse(payload)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: callError('INVALID_PARAMS', 'the params do not match the method schema')
        })
      }
      const { hostEpoch, requestId } = parsed.data
      return client.call(MEMBER_OF[channel], { hostEpoch, requestId }).then(
        (value): IpcResult<unknown> => ({ ok: true, value }),
        (error: unknown): IpcResult<unknown> => ({ ok: false, error: ipcErrorOf(error) })
      )
    }
  }
}
