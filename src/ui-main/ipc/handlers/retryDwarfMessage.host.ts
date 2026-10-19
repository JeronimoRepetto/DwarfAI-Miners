// A-N06 `retryDwarfMessage` / `dwarf:message:retry` served by its `host` handler (14 §2.2 NEW, `host`, owner
// conversation; `RetryMessageParams` → `IpcResult<RetryMessageResult>`; ADR-022 item 5; ADR-019 items 7, 8): Retry of
// a message that failed to deliver, as the same message.
//
// - Main validates the renderer's payload — `{ messageId, requestId }`, the registry's request, the same object as
//   B-M25's params (14 §1.2) — before anything is sent: an invalid payload answers `IpcResult {ok:false, error:
//   INVALID_PARAMS}` and never reaches the Host (ADR-019).
// - A valid payload is relayed as `conversation.retry` (B-M25) through `HostClient.call` with exactly the parsed
//   params. The Host answers at acceptance (14 §1.7) — `{}`, or `cannot-receive` / `not-failed` as the value — and the
//   settlement arrives only as `message.delivery` frames. A Host call error is the result's error branch, never a
//   throw into the renderer (14 §1.5).
// - A-N06 is born `host` in 3a and listed in `unrouted.ts` until the step-3a switch (ISSUE-001) routes it here and the
//   root composes this part (22 §5). A call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs.
//
// Candidate decision (21 §6): no candidate exists in UI main; new code on the `stopDwarf.host.ts` pattern.
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type RetryMessageResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-N06 (invoke), by its registry key. */
export const RETRY_DWARF_MESSAGE = 'dwarf:message:retry' satisfies ChannelKey
/** The invoke rows this target serves. */
export const RETRY_DWARF_MESSAGE_ROWS = [RETRY_DWARF_MESSAGE] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the message retry relay failed')
}

export function createRetryDwarfMessageRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[RETRY_DWARF_MESSAGE].request
  return {
    serve(channel, payload): Promise<IpcResult<RetryMessageResult>> {
      if (channel !== RETRY_DWARF_MESSAGE) {
        return Promise.resolve({
          ok: false,
          error: callError('METHOD_NOT_FOUND', `no route for ${channel}`)
        })
      }
      const parsed = request.safeParse(payload)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: callError('INVALID_PARAMS', 'the params do not match the method schema')
        })
      }
      const { messageId, requestId } = parsed.data
      return client.call('conversation.retry', { messageId, requestId }).then(
        (value): IpcResult<RetryMessageResult> => ({ ok: true, value }),
        (error: unknown): IpcResult<RetryMessageResult> => ({ ok: false, error: ipcErrorOf(error) })
      )
    }
  }
}
