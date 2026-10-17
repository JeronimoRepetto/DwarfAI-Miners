// A-N08 `renameDwarf` / `dwarf:rename` served by its `host` handler (14 §2.2 NEW, `host`, owner crew; §3.4
// `RenameDwarfParams` → `IpcResult<RenameDwarfResult>`; AMENDMENT-2, SC-AR-05; ADR-019 items 7, 8): a person-set
// name for a dwarf of any rank, the successor of the legacy `dwarf:setName` (14 §8 I-21).
//
// - Main validates the renderer's payload — `{ dwarfId, name, requestId }`, the registry's request, the same object
//   as B-M22's params (14 §1.2) — before anything is sent: an invalid payload answers `IpcResult {ok:false, error:
//   INVALID_PARAMS}` and never reaches the Host (ADR-019).
// - A valid payload is relayed as `crew.rename` (B-M22) through `HostClient.call` with exactly the parsed
//   `{ dwarfId, name, requestId }`: the typed text crosses as typed, its `DwarfName` normalization, the `'empty'`
//   outcome and the reset to the base name are the Host's (16 §4.2). The Host's typed outcome is the value; a Host
//   call error is the result's error branch, never a throw into the renderer (14 §1.5).
// - Lead decision (ISSUE-172, 2026-10-17): a NEW row with no legacy owner, routed `host` from the cut-2 table, since
//   the renderer's board is the Host's once its first snapshot is read; the root composes this part (22 §5). A call of
//   any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs: the name is a custom name (14 §3.5 SENSITIVE_METHODS `crew.rename` params; INV-29).
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type RenameDwarfResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-N08 (invoke), by its registry key. */
export const RENAME_DWARF = 'dwarf:rename' satisfies ChannelKey
/** The invoke rows this target serves. */
export const RENAME_DWARF_ROWS = [RENAME_DWARF] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the rename relay failed')
}

export function createRenameDwarfRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[RENAME_DWARF].request
  return {
    serve(channel, payload): Promise<IpcResult<RenameDwarfResult>> {
      if (channel !== RENAME_DWARF) {
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
      const { dwarfId, name, requestId } = parsed.data
      return client.call('crew.rename', { dwarfId, name, requestId }).then(
        (value): IpcResult<RenameDwarfResult> => ({ ok: true, value }),
        (error: unknown): IpcResult<RenameDwarfResult> => ({ ok: false, error: ipcErrorOf(error) })
      )
    }
  }
}
