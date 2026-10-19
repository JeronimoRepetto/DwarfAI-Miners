// A-N29 `stopDwarf` / `dwarf:stop` served by its `host` handler (14 §2.2 NEW, `host`, owner crew; §3.4
// `StopDwarfParams` → `IpcResult<StopDwarfResult>`; AMENDMENT-2, OQ-54; ADR-014; ADR-019 items 7, 8): "Stop dwarf…"
// ends the dwarf's whole session, also while a turn is open, never only the turn.
//
// - Main validates the renderer's payload — `{ dwarfId, requestId }`, the registry's request, the same object as
//   B-M21's params (14 §1.2) — before anything is sent: an invalid payload answers `IpcResult {ok:false, error:
//   INVALID_PARAMS}` and never reaches the Host (ADR-019).
// - A valid payload is relayed as `crew.stop` (B-M21) through `HostClient.call` with exactly the parsed
//   `{ dwarfId, requestId }` (the renderer minted the requestId once, 14 §1.6; deadline 60 s, 14 §3.10). The Host's
//   typed outcome — `{}`, `already-stopping` or `could-not-end` — is the value; the failure's one toast arrives as a
//   frame. A Host call error is the result's error branch, never a throw into the renderer (14 §1.5).
// - A-N29 is born `host` in 3a and is listed in `unrouted.ts` until the step-3a switch (ISSUE-001) routes it here,
//   through `LegacyEndFirstAdapter` for a legacy-launched session (21 §2 step 3a), and the root composes this part
//   (22 §5). A call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs.
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type StopDwarfResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-N29 (invoke), by its registry key. */
export const STOP_DWARF = 'dwarf:stop' satisfies ChannelKey
/** The invoke rows this target serves. */
export const STOP_DWARF_ROWS = [STOP_DWARF] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the stop relay failed')
}

export function createStopDwarfRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[STOP_DWARF].request
  return {
    serve(channel, payload): Promise<IpcResult<StopDwarfResult>> {
      if (channel !== STOP_DWARF) {
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
      const { dwarfId, requestId } = parsed.data
      return client.call('crew.stop', { dwarfId, requestId }).then(
        (value): IpcResult<StopDwarfResult> => ({ ok: true, value }),
        (error: unknown): IpcResult<StopDwarfResult> => ({ ok: false, error: ipcErrorOf(error) })
      )
    }
  }
}
