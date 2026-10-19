// A-N31 `setClaudeHooksEnabled` / `claude:hooks:set` served by its `host` handler (14 §2.2 NEW, `host`, owner
// preferences; §3.4 `SetClaudeHooksParams`, `SetClaudeHooksResult`; §3.8; AMENDMENT-7, OQ-68; ADR-016 items 5–7;
// ADR-019 items 7, 8): Settings → Integrations "Claude Code · instant updates", the equivalent of A-53 for DwarfAI's
// hook entry in Claude Code's settings.
//
// - Main validates the renderer's payload — `{ on, requestId }`, the registry's request, the same object as B-M39's
//   params (14 §1.2) — before anything is sent: an invalid payload, an `origin` included, answers
//   `IpcResult {ok:false, error: INVALID_PARAMS}` and never reaches the Host (ADR-019). The router's seam A gate
//   checks the same schema; this check keeps the handler safe on its own.
// - A valid payload is relayed unchanged as `preferences.setClaudeHooks` (B-M39) through `HostClient.call`, the
//   renderer's `requestId` included: main mints nothing, and the Host records the consent origin `settings`. The
//   stored state comes back as `IpcResult<SetClaudeHooksResult>`; `config-write-failed` and `config-revert-failed`
//   are outcomes of that result (a locked turn-off keeps the option on, 16 §7.4), never call errors. A Host call error
//   (`FORBIDDEN`, `HOST_NOT_READY`, …) is the result's error branch, never a throw into the renderer (14 §1.5).
// - A-N31 is born `host` in cut 2 and is listed in `unrouted.ts` until the cut-2 switch (ISSUE-141) routes it here
//   and the root composes this part (22 §5). A call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs; the payload is a boolean and a requestId, and no token ever crosses seam A.
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type SetClaudeHooksResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-N31 (invoke), by its registry key. */
export const SET_CLAUDE_HOOKS = 'claude:hooks:set' satisfies ChannelKey
/** The invoke rows this target serves. */
export const SET_CLAUDE_HOOKS_ROWS = [SET_CLAUDE_HOOKS] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the Claude Code hooks relay failed')
}

export function createSetClaudeHooksRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[SET_CLAUDE_HOOKS].request
  return {
    serve(channel, payload): Promise<IpcResult<SetClaudeHooksResult>> {
      if (channel !== SET_CLAUDE_HOOKS) {
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
      return client.call('preferences.setClaudeHooks', parsed.data).then(
        (result): IpcResult<SetClaudeHooksResult> => ({ ok: true, value: result }),
        (error: unknown): IpcResult<SetClaudeHooksResult> => ({
          ok: false,
          error: ipcErrorOf(error)
        })
      )
    }
  }
}
