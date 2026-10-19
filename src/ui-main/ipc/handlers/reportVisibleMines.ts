// The handler of A-44 `reportVisibleMines` (14 §2.1 row A-44, CHANGE: `setOpenMine` / `panel:openMine` renamed;
// `ui-local`, owner `window`; ADR-024 item 7): a route target of the router (ADR-001 item 3), so every call has passed
// the seam A gate first, sender and payload (`validate.ts`, ADR-019 items 7, 8) and arrives in its 14 shape
// `{ mineIds: MineId[] }`. One-way: it answers nothing. It hands the sender window's report to the `PresenceTracker`,
// which sends `presence` (B-M07) to the Host on a change.
//
// The row stays `legacy` with `shape: 'today'` until the cut-1 switch routes it here (later: ISSUE-123; 21 §3.1). A
// call of any other channel is refused like a call with no route, so this target never serves a row that is not its
// own, and a call main makes itself (no sender window) reports nothing.
import type { ChannelKey, IpcError, MineId } from '@dwarfai/contracts'
import type { PresenceTracker } from '../../window/application/presenceTracker'
import type { RouteTarget } from '../router'

/** A-44 (`ui-local`), by its registry key. */
export const REPORT_VISIBLE_MINES = 'presence:visibleMines' satisfies ChannelKey

export function createReportVisibleMinesRow(tracker: Pick<PresenceTracker, 'report'>): RouteTarget {
  return {
    serve(channel, payload, sender) {
      if (channel !== REPORT_VISIBLE_MINES) {
        const error: IpcError = {
          code: 'METHOD_NOT_FOUND',
          message: `no route for ${channel}`,
          retryable: false
        }
        return Promise.resolve({ ok: false, error })
      }
      if (sender !== undefined) {
        tracker.report(sender.sender.id, (payload as { mineIds: MineId[] }).mineIds)
      }
      return Promise.resolve(undefined)
    }
  }
}
