// A-N07 `setAskStep` / `ask:step:set` served by its `host` handler (14 §2.2 NEW, `host`, owner asking; §3.4
// `SetAskStepParams` → `IpcResult<void>`; §3.8; OQ-03, PO #92; ADR-010 item 9; ADR-019 items 7, 8): the step a
// person is on while walking a multi-step question, so that every window and a later reopen find the card on it.
//
// - Main validates the renderer's payload — `{ askId, step }`, the registry's request, the same object as B-M32's
//   params (14 §1.2) — before anything is sent: an invalid payload (a pick, a requestId, a negative or non-integer
//   step, any other key) answers `IpcResult {ok:false, error: INVALID_PARAMS}` and never reaches the Host
//   (ADR-019). The router's seam A gate checks the same schema; this check keeps the handler safe on its own.
// - A valid payload is relayed as `asking.setStep` (B-M32) through `HostClient.call` with exactly the parsed
//   `{ askId, step }`: the picks stay in UI main's session store (14 §3.9 `ask-picks`), never in the Host (OQ-03).
//   B-M32 answers `{}`, an ask that closed meanwhile included, so the renderer gets `{ ok: true }`. A Host call
//   error (`FORBIDDEN`, `HOST_NOT_READY`, …) is the result's error branch, never a throw into the renderer (14 §1.5).
// - A-N07 is born `host` in cut 2 and is listed in `unrouted.ts` until the cut-2 switch (ISSUE-141) routes it here
//   and the root composes this part (22 §5). A call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs.
import { CHANNELS, type ChannelKey, type IpcError, type IpcResult } from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-N07 (invoke), by its registry key. */
export const SET_ASK_STEP = 'ask:step:set' satisfies ChannelKey
/** The invoke rows this target serves. */
export const SET_ASK_STEP_ROWS = [SET_ASK_STEP] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the ask step relay failed')
}

export function createSetAskStepRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[SET_ASK_STEP].request
  return {
    serve(channel, payload): Promise<IpcResult<void>> {
      if (channel !== SET_ASK_STEP) {
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
      const { askId, step } = parsed.data
      return client.call('asking.setStep', { askId, step }).then(
        (): IpcResult<void> => ({ ok: true, value: undefined }),
        (error: unknown): IpcResult<void> => ({ ok: false, error: ipcErrorOf(error) })
      )
    }
  }
}
