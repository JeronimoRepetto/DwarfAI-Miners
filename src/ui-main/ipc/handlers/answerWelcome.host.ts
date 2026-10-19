// A-N32 `answerWelcome` / `welcome:answer` served by its `host` handler (14 §2.2 NEW, `host`, owner preferences;
// §3.4 `AnswerWelcomeParams`, `AnswerWelcomeResult`; §3.8; §3.10 30 s; AMENDMENT-7, OQ-68; ADR-016 item 5; ADR-019
// items 7, 8; 07 machine 41): the first-run consent step's one answer, "Activate" with the ticks as the person left
// them (both false = "Not now").
//
// - Main validates the renderer's payload — `{ claudeHooks, openCodePermissions, requestId }`, the registry's
//   request, the same object as B-M40's params (14 §1.2) — before anything is sent: an invalid payload, an `origin`
//   included, answers `IpcResult {ok:false, error: INVALID_PARAMS}` and never reaches the Host (ADR-019). The
//   router's seam A gate checks the same schema; this check keeps the handler safe on its own.
// - A valid payload is relayed unchanged as `preferences.answerWelcome` (B-M40) through `HostClient.call`, the
//   renderer's `requestId` included: main mints nothing, and the Host records the consent origin `first-run`. Every
//   integration's state, with its failure, and the settled step come back as `IpcResult<AnswerWelcomeResult>`; a
//   failed write or revert is inside that result, never a call error. A Host call error (`FORBIDDEN`, `TIMEOUT`, …)
//   is the result's error branch, never a throw into the renderer (14 §1.5); a `TIMEOUT` keeps the step shown until
//   `integration.changed` and `preferences.changed` settle it (14 §3.10).
// - A-N32 is born `host` in cut 2 and is listed in `unrouted.ts` until the cut-2 switch (ISSUE-141) routes it here
//   and the root composes this part (22 §5). A call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs; the payload is two booleans and a requestId.
import {
  CHANNELS,
  type AnswerWelcomeResult,
  type ChannelKey,
  type IpcError,
  type IpcResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-N32 (invoke), by its registry key. */
export const ANSWER_WELCOME = 'welcome:answer' satisfies ChannelKey
/** The invoke rows this target serves. */
export const ANSWER_WELCOME_ROWS = [ANSWER_WELCOME] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the first-run answer relay failed')
}

export function createAnswerWelcomeRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[ANSWER_WELCOME].request
  return {
    serve(channel, payload): Promise<IpcResult<AnswerWelcomeResult>> {
      if (channel !== ANSWER_WELCOME) {
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
      return client.call('preferences.answerWelcome', parsed.data).then(
        (result): IpcResult<AnswerWelcomeResult> => ({ ok: true, value: result }),
        (error: unknown): IpcResult<AnswerWelcomeResult> => ({
          ok: false,
          error: ipcErrorOf(error)
        })
      )
    }
  }
}
