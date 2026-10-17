// A-13 `activateDwarf` / `dwarf:activate`, the split row (14 §2.1 CHANGE, split: conversation resolves, window
// executes; §3.8 `ActivateDwarfRequest` → `IpcResult<ConsoleOpenResult>`; ADR-031 items 1–5; UC-036; PO #42, #100):
// "Open console" (header icon, `⋯` menu) and "Jump to terminal" (an ask card) open the dwarf's console.
//
// - Main validates the renderer's payload — `{ dwarfId, purpose }`, strict — before anything is sent: an invalid
//   payload answers `IpcResult {ok:false, error: INVALID_PARAMS}` and never reaches the Host (ADR-019).
// - A valid payload asks the Host for the dwarf's `ConsoleTarget` with B-M29 `conversation.resolveConsole {dwarfId}`,
//   then executes it at once through `NativeActions.raiseConsole`, while the click still holds the foreground right
//   (ADR-031 item 4). Both purposes resolve and open the same console; neither answers, closes or touches an ask
//   (US-MSG-007.AC02): no `asking.*` method is ever called here.
// - `focus-terminal` raised → `{outcome:'raised', mode:'focus-terminal'}`. A focus that fails falls back to the `log`
//   view the same target carries (ADR-031 item 1: "focus first, `log` second") → `{outcome:'opened', mode:'log'}`.
//   `log` opened → `{outcome:'opened', mode:'log'}`. Anything that could not be executed → `{outcome:'failed', mode}`,
//   the mode it last tried (FM-054). No toast and no confirmation in any case (US-MSG-007.AC03, PO #42): the answer is
//   the value, and the renderer shows nothing for it.
// - A Host call error is the result's error branch, never a throw into the renderer (14 §1.5). The target holds paths
//   (14 §3.5 SENSITIVE_METHODS): it never reaches the renderer, and nothing here logs.
// - Today's `DwarfActivation.feed` fallback is retired: every dwarf has a console (ADR-031 item 3).
//
// The table routes A-13 through `LegacyDwarfIdBridge` today; the switch that routes it here is the cut's (22 §5), and
// the root composes this part only where the table routes the row `host`.
import {
  CHANNELS,
  type ChannelKey,
  type ConsoleOpenResult,
  type ConsoleTarget,
  type IpcError,
  type IpcResult
} from '@dwarfai/contracts'
import type { ServedNativeActions } from '../../window/application/nativeActions'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-13 (invoke), by its registry key. */
export const ACTIVATE_DWARF = 'dwarf:activate' satisfies ChannelKey
/** The invoke rows this target serves. */
export const ACTIVATE_DWARF_ROWS = [ACTIVATE_DWARF] as const

export interface ActivateDwarfDeps {
  client: Pick<HostClient, 'call'>
  consoles: Pick<ServedNativeActions, 'raiseConsole'>
}

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the console relay failed')
}

/** Executes `target` (ADR-031 item 4), focus first and the `log` view second. */
export async function openConsole(
  target: ConsoleTarget,
  consoles: ActivateDwarfDeps['consoles']
): Promise<ConsoleOpenResult> {
  if (target.mode === 'focus-terminal') {
    if ((await consoles.raiseConsole(target)) === 'raised') {
      return { outcome: 'raised', mode: 'focus-terminal' }
    }
    if (target.command === undefined) return { outcome: 'failed', mode: 'focus-terminal' }
    const log: ConsoleTarget = {
      mode: 'log',
      command: target.command,
      ...(target.credentialFile === undefined ? {} : { credentialFile: target.credentialFile })
    }
    return openConsole(log, consoles)
  }
  return (await consoles.raiseConsole(target)) === 'raised'
    ? { outcome: 'opened', mode: target.mode }
    : { outcome: 'failed', mode: target.mode }
}

export function createActivateDwarfRow(deps: ActivateDwarfDeps): RouteTarget {
  const request = CHANNELS[ACTIVATE_DWARF].request
  return {
    async serve(channel, payload): Promise<IpcResult<ConsoleOpenResult>> {
      if (channel !== ACTIVATE_DWARF) {
        return { ok: false, error: callError('METHOD_NOT_FOUND', `no route for ${channel}`) }
      }
      const parsed = request.safeParse(payload)
      if (!parsed.success) {
        return {
          ok: false,
          error: callError('INVALID_PARAMS', 'the params do not match the method schema')
        }
      }
      let target: ConsoleTarget
      try {
        target = await deps.client.call('conversation.resolveConsole', {
          dwarfId: parsed.data.dwarfId
        })
      } catch (error) {
        return { ok: false, error: ipcErrorOf(error) }
      }
      return { ok: true, value: await openConsole(target, deps.consoles) }
    }
  }
}
