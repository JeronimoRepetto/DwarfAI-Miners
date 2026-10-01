// The handlers of Stop everything and quit's seam A rows (14 §2.2; ADR-002 D7 steps 2–3; 07 S10.19, S10.20): a route
// target of the router (ADR-001 item 3), so every call has passed the seam A gate first, sender and payload
// (`validate.ts`, ADR-019 items 7, 8), and arrives in its target shape.
//
// - A-N26 `confirmStopEverything` (`host`): relays `host.shutdown {mode:'stop-all', requestId}` on the confirmation's
//   `ui` connection and answers `IpcResult<StopAllOutcome>` (window/application/stopEverything.ts). Through cut 4 the
//   cut-0 switch (ISSUE-056) composes `LegacyEndFirstAdapter` (ISSUE-054) as the use case's relay, so this row ends
//   the legacy-launched sessions first without another handler.
// - A-N27 `cancelStopEverything` (`ui-local`): one-way, closes the confirmation, sends nothing.
// - A-N34 `requestStopEverything` (`ui-local`; amendment owner-approved 2026-10-01, ISSUE-316): one-way, a window asks
//   for the tray item's flow; the use case opens no second confirmation while one is open or being opened.
// - A-N25 `onStopEverythingRequested` is a push: UI main sends it (the use case), no handler serves it.
//
// The rows are listed in `contracts/ipc/unrouted.ts` until the cut-0 switch routes them. A call of any other channel
// is refused like a call with no route, so this target never serves a row that is not its own.
import type { ChannelKey, IpcError } from '@dwarfai/contracts'
import type { StopEverything } from '../../window/application/stopEverything'
import type { RouteTarget } from '../router'

/** A-N26 (`host`). */
export const STOP_EVERYTHING_CONFIRM = 'tray:stopEverything:confirm' satisfies ChannelKey
/** A-N27 (`ui-local`). */
export const STOP_EVERYTHING_CANCEL = 'tray:stopEverything:cancel' satisfies ChannelKey
/** A-N34 (`ui-local`). */
export const STOP_EVERYTHING_REQUEST = 'tray:stopEverything:request' satisfies ChannelKey
/** The rows this target serves. */
export const STOP_EVERYTHING_ROWS = [
  STOP_EVERYTHING_CONFIRM,
  STOP_EVERYTHING_CANCEL,
  STOP_EVERYTHING_REQUEST
] as const

export function createStopEverythingRows(
  stop: Pick<StopEverything, 'confirm' | 'cancel' | 'requestFromWindow'>
): RouteTarget {
  return {
    serve(channel, payload) {
      if (channel === STOP_EVERYTHING_REQUEST) {
        void stop.requestFromWindow()
        return Promise.resolve(undefined)
      }
      if (channel === STOP_EVERYTHING_CONFIRM) {
        return stop.confirm(payload as { confirmationId: string; requestId: string })
      }
      if (channel === STOP_EVERYTHING_CANCEL) {
        stop.cancel(payload as { confirmationId: string })
        return Promise.resolve(undefined)
      }
      const error: IpcError = {
        code: 'METHOD_NOT_FOUND',
        message: `no route for ${channel}`,
        retryable: false
      }
      return Promise.resolve({ ok: false, error })
    }
  }
}
