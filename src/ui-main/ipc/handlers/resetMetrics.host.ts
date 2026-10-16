// A-33 `resetMetrics` / `metrics:reset` served by its `host` handler (14 §2.1 row A-33: relays
// `preferences.resetMetrics`, the toast only on `outcome:'reset'`; §3.4 `ResetMetricsParams`,
// `MetricsResetResult`; ADR-019; ADR-023 items 4–5): from step 4a "Reset metrics" is the Host saga
// alone, with no legacy reset beside it (21 §3: `ResetFanout` ends in 4a; ISSUE-233).
//
// - Main validates the renderer's payload with A-33's strict schema — `confirmed: 'yes'` and a
//   `requestId`, the same object as B-M15's params (14 §1.2) — before anything is sent: anything
//   else answers `IpcResult {ok:false, error: INVALID_PARAMS}` and never reaches the Host
//   (ADR-019, ADR-023 item 5). The router's seam A gate checks the same schema; this check keeps
//   the handler safe on its own.
// - A valid payload is relayed unchanged as `preferences.resetMetrics` (B-M15) on the window's `ui`
//   connection (B-M15 is a `ui` method, 14 §2.3; `withUiConnection` opens a short-lived one when no
//   window holds one), the renderer's `requestId` included, so the Host's de-duplication (14 §1.6)
//   joins a repeat to the first saga. The saga's result comes back unchanged as
//   `IpcResult<MetricsResetResult>`: `reset` with its `epoch`, or `failed` with
//   `resumesOnNextStart`. A Host call error (`HOST_NOT_READY`, …) is the result's error branch, never
//   a throw into the renderer (14 §1.5), so the toast never shows for a reset that did not finish.
// - A-33 is routed `host` + `target` by the step-4a switch (ISSUE-235), which composes this part in
//   the root (22 §5); until then `ResetFanout` serves it. A call of any other channel is refused,
//   never guessed (14 §1.5).
//
// Nothing here logs; the payload is a confirmation and a requestId.
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type MetricsResetResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-33 (invoke), by its registry key. */
export const RESET_METRICS = 'metrics:reset' satisfies ChannelKey
/** The invoke rows this target serves. */
export const RESET_METRICS_ROWS = [RESET_METRICS] as const

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

export function createResetMetricsRow(client: Pick<HostClient, 'withUiConnection'>): RouteTarget {
  const request = CHANNELS[RESET_METRICS].request
  return {
    serve(channel, payload): Promise<IpcResult<MetricsResetResult>> {
      if (channel !== RESET_METRICS) {
        return Promise.resolve({
          ok: false,
          error: callError('METHOD_NOT_FOUND', `no route for ${channel}`)
        })
      }
      const parsed = request.safeParse(payload)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: callError('INVALID_PARAMS', 'resetMetrics needs confirmed: yes and a requestId')
        })
      }
      return client
        .withUiConnection((ui) => ui.call('preferences.resetMetrics', parsed.data))
        .then(
          (result): IpcResult<MetricsResetResult> => ({ ok: true, value: result }),
          (error: unknown): IpcResult<MetricsResetResult> => ({
            ok: false,
            error: ipcErrorOf(error)
          })
        )
    }
  }
}
