// A-39 `launchHostedProcess` / `agent:launchHosted` served by its `host` handler from step 3d (14 §2.1 CHANGE, `host`,
// owner launching; §3.4 `LaunchCustomParams` → `IpcResult<LaunchAccepted>`; ADR-020 item 3; ADR-019 items 7, 8): an
// "Other…" launch of the person's own command from the Add panel, and the Retry of a failed one (`retryOf`).
//
// - Main validates the renderer's payload — `LaunchCustomParams`, the registry's request, the same object as B-M34's
//   params (14 §1.2) — before anything is sent: an invalid payload answers `IpcResult {ok:false, error:
//   INVALID_PARAMS}` and never reaches the Host (ADR-019).
// - A valid payload is relayed as `launching.launchCustom` (B-M34) through `HostClient.call` with exactly the parsed
//   params (the renderer minted the requestId once, 14 §1.6). The command is not parsed here: the Host parses it with no
//   shell and settles a refusal as `launch.failed{could-not-start}` (14 §2.1 A-39 Notes; NFR-SEC-09). The Host answers
//   `LaunchAccepted` at acceptance (14 §1.7); the settlement arrives only as `launch.changed` / `launch.failed` frames.
//   A Host call error is the result's error branch, never a throw into the renderer (14 §1.5).
// - The row is one unqualified route (21 §3.1: no shape adapter, it switches with its route); the step-3d switch
//   (ISSUE-186) routes it and the root composes this part (22 §5). A call of any other channel is refused (14 §1.5).
//
// Nothing here logs: the params carry the prompt and the command (14 §3.5 SENSITIVE_METHODS `launching.launchCustom`).
//
// Candidate decision (21 §6): today's A-39 handler (`LegacyRuntimeRoute`, `runtime.launchHostedProcess`) serves
// today's shape and owns the process in the window, so it does not conform; new code on the `launchAgent.host.ts`
// pattern.
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type LaunchAccepted
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-39 (invoke), by its registry key. */
export const LAUNCH_CUSTOM = 'agent:launchHosted' satisfies ChannelKey
/** The invoke rows this target serves. */
export const LAUNCH_CUSTOM_ROWS = [LAUNCH_CUSTOM] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the custom launch relay failed')
}

export function createLaunchCustomRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[LAUNCH_CUSTOM].request
  return {
    serve(channel, payload): Promise<IpcResult<LaunchAccepted>> {
      if (channel !== LAUNCH_CUSTOM) {
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
      return client.call('launching.launchCustom', parsed.data).then(
        (value): IpcResult<LaunchAccepted> => ({ ok: true, value }),
        (error: unknown): IpcResult<LaunchAccepted> => ({ ok: false, error: ipcErrorOf(error) })
      )
    }
  }
}
