// A-35 `launchAgent` / `agent:launch` served by its `host` handler (14 §2.1 CHANGE, `host`, owner launching; §3.4
// `LaunchParams` → `IpcResult<LaunchAccepted>`; ADR-020; ADR-019 items 7, 8): a launch from the Add panel, by a
// supplier or by "Let Jev choose", and the Retry of a failed launch (`retryOf`) on the same row.
//
// - Main validates the renderer's payload — `LaunchParams`, the registry's request, the same object as B-M33's params
//   (14 §1.2) — before anything is sent: an invalid payload answers `IpcResult {ok:false, error: INVALID_PARAMS}` and
//   never reaches the Host (ADR-019).
// - A valid payload is relayed as `launching.launch` (B-M33) through `HostClient.call` with exactly the parsed params
//   (the renderer minted the requestId once, 14 §1.6). The Host answers `LaunchAccepted` at acceptance (14 §1.7); the
//   settlement arrives only as `launch.changed` / `launch.failed` frames. A Host call error is the result's error
//   branch, never a throw into the renderer (14 §1.5).
// - From step 3a the row is provider-qualified (21 §2 cut 3a): the table routes the providers the Host launches here
//   and every other one through `PerProviderShapeAdapter` (`providerQualifiers.ts`); the step-3a switch (ISSUE-001)
//   routes it and the root composes this part (22 §5). A call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs: the params carry the prompt (14 §3.5 SENSITIVE_METHODS `launching.launch`).
//
// Candidate decision (21 §6): no candidate exists in UI main; new code on the `stopDwarf.host.ts` pattern.
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type LaunchAccepted
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-35 (invoke), by its registry key. */
export const LAUNCH_AGENT = 'agent:launch' satisfies ChannelKey
/** The invoke rows this target serves. */
export const LAUNCH_AGENT_ROWS = [LAUNCH_AGENT] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the launch relay failed')
}

export function createLaunchAgentRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[LAUNCH_AGENT].request
  return {
    serve(channel, payload): Promise<IpcResult<LaunchAccepted>> {
      if (channel !== LAUNCH_AGENT) {
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
      return client.call('launching.launch', parsed.data).then(
        (value): IpcResult<LaunchAccepted> => ({ ok: true, value }),
        (error: unknown): IpcResult<LaunchAccepted> => ({ ok: false, error: ipcErrorOf(error) })
      )
    }
  }
}
