// A-N09 `resetDwarfName` / `dwarf:name:reset` served by its `host` handler (14 §2.2 NEW, `host`, owner crew; §3.4
// `ResetDwarfNameParams` → `IpcResult<void>`; ADR-019 items 7, 8): the ⋯ menu's Reset name, with no confirmation, the
// successor of the legacy `dwarf:resetName` (14 §8 I-21).
//
// - Main validates the renderer's payload — `{ dwarfId, requestId }`, the registry's request, the same object as
//   B-M23's params (14 §1.2) — before anything is sent: an invalid payload answers `IpcResult {ok:false, error:
//   INVALID_PARAMS}` and never reaches the Host (ADR-019).
// - A valid payload is relayed as `crew.resetName` (B-M23) through `HostClient.call` with exactly the parsed
//   `{ dwarfId, requestId }`. B-M23 answers `{}`, which 14 §2.2 reads as `IpcResult<void>`; a Host call error is the
//   result's error branch, never a throw into the renderer (14 §1.5).
// - Lead decision (ISSUE-172, 2026-10-17): routed `host` from the cut-2 table with A-N08; the root composes this part
//   (22 §5). A call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs.
import { CHANNELS, type ChannelKey, type IpcError, type IpcResult } from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-N09 (invoke), by its registry key. */
export const RESET_DWARF_NAME = 'dwarf:name:reset' satisfies ChannelKey
/** The invoke rows this target serves. */
export const RESET_DWARF_NAME_ROWS = [RESET_DWARF_NAME] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the reset relay failed')
}

export function createResetDwarfNameRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[RESET_DWARF_NAME].request
  return {
    serve(channel, payload): Promise<IpcResult<void>> {
      if (channel !== RESET_DWARF_NAME) {
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
      return client.call('crew.resetName', { dwarfId, requestId }).then(
        (): IpcResult<void> => ({ ok: true, value: undefined }),
        (error: unknown): IpcResult<void> => ({ ok: false, error: ipcErrorOf(error) })
      )
    }
  }
}
