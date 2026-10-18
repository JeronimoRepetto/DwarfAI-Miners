// A-50 `routeJevLaunch` / `jev:route` served by its `host` handler (14 §2.2 CHANGE, `host`, owner jev; §3.4
// `JevSuggestParams`, `JevSuggestResult`; ADR-019 items 7, 8; ADR-028): the Add panel's "Let Jev choose" card, asked of
// the Host's Jev advisor instead of today's main-side router.
//
// - Main validates the renderer's payload — the registry's `JevSuggestParams` — before anything is sent: an invalid
//   payload answers `IpcResult {ok:false, error: INVALID_PARAMS}` and never reaches the Host (ADR-019).
// - A valid payload is relayed as `jev.suggest` (B-M38) unchanged through `HostClient.call`, and the Host's
//   `JevSuggestResult` comes back unchanged as `IpcResult<JevSuggestResult>`: a Jev outcome that names no suggestion
//   (`jev-unreachable`, `jev-could-not-choose`, `not-configured`) is the result, not an error. The effort ceiling is
//   applied by the Host; the card is never stored (INV-87). A Host call error (`FORBIDDEN`, `HOST_NOT_READY`, …) is the
//   result's error branch, never a throw into the renderer (14 §1.5).
// - A-50 keeps `shape: 'today'` on its `legacy` route until the step-3a switch (ISSUE-001) routes it here and the root
//   composes this part (`composeJevRouteRow`). A call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs: the prompt is sensitive (14 §3.5 SENSITIVE_METHODS `jev.suggest: 'params'`).
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type JevSuggestResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-50 (invoke), by its registry key. */
export const ROUTE_JEV_LAUNCH = 'jev:route' satisfies ChannelKey
/** The invoke rows this target serves. */
export const ROUTE_JEV_LAUNCH_ROWS = [ROUTE_JEV_LAUNCH] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the Jev suggestion relay failed')
}

export function createRouteJevLaunchRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[ROUTE_JEV_LAUNCH].request
  return {
    serve(channel, payload): Promise<IpcResult<JevSuggestResult>> {
      if (channel !== ROUTE_JEV_LAUNCH) {
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
      return client.call('jev.suggest', parsed.data).then(
        (result): IpcResult<JevSuggestResult> => ({ ok: true, value: result }),
        (error: unknown): IpcResult<JevSuggestResult> => ({ ok: false, error: ipcErrorOf(error) })
      )
    }
  }
}
