import type { OpenCodeControlServerPort } from './controlServer'
import {
  decideOpenCodeCredential,
  providerIdOf,
  readConnectedProviders,
  type OpenCodeConnectedFetch,
  type OpenCodeCredentialDecision
} from './credentialCheck'

export type { OpenCodeConnectedFetch }

/**
 * Whether an OpenCode launch may proceed, checked once per launch attempt
 * against the chosen model's own provider (#597 T3) — composes T1's control
 * server with T2's reader and decision, so `AgentRuntime.launchAgent` holds
 * no HTTP or process-spawning logic of its own for this.
 *
 * FAILS OPEN. Every way this can go wrong — the control server would not
 * start, the read timed out, the body could not be parsed — is
 * `{kind:'check-failed'}` rather than `{kind:'credential-missing'}`, because
 * a broken check must never be the reason a launch that would otherwise work
 * stops working. `detail` is for the caller's own log line, never for a
 * person: they asked to launch a session, not to read a connectivity report.
 */
export type OpenCodeLaunchGateOutcome =
  OpenCodeCredentialDecision | { kind: 'check-failed'; detail: string }

export type OpenCodeLaunchCredentialGate = (
  model: string | undefined
) => Promise<OpenCodeLaunchGateOutcome>

export interface OpenCodeLaunchCredentialGateOptions {
  /** Only `ensure()` is read — never `stop()`, which belongs to app shutdown alone. */
  controlServer: Pick<OpenCodeControlServerPort, 'ensure'>
  fetch: OpenCodeConnectedFetch
}

export function createOpenCodeLaunchCredentialGate(
  options: OpenCodeLaunchCredentialGateOptions
): OpenCodeLaunchCredentialGate {
  return async (model) => {
    // No model, or a string this format cannot even read a provider out of:
    // `decideOpenCodeCredential` would say 'ready' anyway, but checking here
    // first spares a launch with nothing to check the control server's own
    // start (~700ms measured) entirely.
    if (model === undefined || providerIdOf(model) === undefined) return { kind: 'ready' }

    const server = await options.controlServer.ensure()
    if (!server.ok) {
      return { kind: 'check-failed', detail: `control server: ${server.reason}` }
    }
    const read = await readConnectedProviders(options.fetch, server.url, server.readPassword())
    if (!read.ok) {
      return { kind: 'check-failed', detail: `GET /provider: ${read.reason}` }
    }
    return decideOpenCodeCredential(model, read.connected)
  }
}
