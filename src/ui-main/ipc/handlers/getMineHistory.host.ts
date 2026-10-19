// A-19 `getMineHistory` / `mine:history` served by its `host` handler (14 §2.1 CHANGE, `host`, owner conversation;
// §3.6 `MineHistoryView`; §3.8; ADR-007 item 5; ADR-019 items 7, 8; PO #87): a mine's history panel, every dwarf that
// worked there with its ≤ 50 stored rows, read from the Host's message log and no longer from provider files.
//
// - Main validates the renderer's payload — a `MineId` string, the registry's request — before anything is sent: an
//   invalid payload answers `IpcResult {ok:false, error: INVALID_PARAMS}` and never reaches the Host (ADR-019). The
//   router's seam A gate checks the same schema; this check keeps the handler safe on its own.
// - A valid `mineId` is relayed as `conversation.mineHistory` (B-M27) with `{ mineId }` through `HostClient.call`, and
//   the history comes back unchanged as `IpcResult<MineHistoryView>`. A Host call error (`FORBIDDEN`,
//   `HOST_NOT_READY`, …) is the result's error branch, never a throw into the renderer (14 §1.5).
// - A-19 keeps `shape: 'today'` on its `legacy` route until the cut-1 switch (ISSUE-123) routes it here and the root
//   composes this part (21 §3.1). A call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs: the result carries message text (14 §3.5 SENSITIVE_METHODS `conversation.mineHistory: 'result'`).
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type MineHistoryView
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-19 (invoke), by its registry key. */
export const GET_MINE_HISTORY = 'mine:history' satisfies ChannelKey
/** The invoke rows this target serves. */
export const GET_MINE_HISTORY_ROWS = [GET_MINE_HISTORY] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the mine history relay failed')
}

export function createGetMineHistoryRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[GET_MINE_HISTORY].request
  return {
    serve(channel, payload): Promise<IpcResult<MineHistoryView>> {
      if (channel !== GET_MINE_HISTORY) {
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
      return client.call('conversation.mineHistory', { mineId: parsed.data }).then(
        (history): IpcResult<MineHistoryView> => ({ ok: true, value: history }),
        (error: unknown): IpcResult<MineHistoryView> => ({ ok: false, error: ipcErrorOf(error) })
      )
    }
  }
}
