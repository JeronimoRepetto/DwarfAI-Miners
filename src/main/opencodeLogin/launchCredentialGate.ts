import type { OpenCodeControlServerPort } from './controlServer'
import {
  decideOpenCodeCredential,
  providerIdOf,
  readConfiguredModel,
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
 *
 * ## No model chosen (#597 T3b)
 *
 * A launch that names no model is not "nothing to check": `opencode run`
 * still starts on a model, the one OpenCode's own configuration resolves for
 * the folder it runs in — a project's own `opencode.json` there can name a
 * different model than the rest of the machine. `directory` is that folder,
 * read only to resolve `GET /config`'s own `directory` query parameter
 * (measured live against OpenCode 1.18.32, `GET /doc`); nothing else of the
 * response is ever read, on the same discipline `readConfiguredModel` itself
 * holds. The model that answer names (or its absence) is then checked
 * exactly like a chosen one — same `providerIdOf` shape gate, same
 * `decideOpenCodeCredential` — so `credentialMissing` never has to say
 * whether the model came from the Add Panel or from OpenCode's own default.
 */
export type OpenCodeLaunchGateOutcome =
  OpenCodeCredentialDecision | { kind: 'check-failed'; detail: string }

export type OpenCodeLaunchCredentialGate = (
  model: string | undefined,
  /** The folder the launch runs in — read only to resolve `GET /config` for it when `model` is absent. */
  directory: string
) => Promise<OpenCodeLaunchGateOutcome>

export interface OpenCodeLaunchCredentialGateOptions {
  /** Only `ensure()` is read — never `stop()`, which belongs to app shutdown alone. */
  controlServer: Pick<OpenCodeControlServerPort, 'ensure'>
  fetch: OpenCodeConnectedFetch
}

export function createOpenCodeLaunchCredentialGate(
  options: OpenCodeLaunchCredentialGateOptions
): OpenCodeLaunchCredentialGate {
  return async (model, directory) => {
    // An explicit model this format cannot even read a provider out of has
    // nothing to check either way: `decideOpenCodeCredential` would say
    // 'ready' anyway, but checking here first spares it the control server's
    // own start (~700ms measured) entirely. Only an EXPLICIT model gets this
    // shortcut — `undefined` still has the folder's configured default to
    // read below, which is exactly what T3b adds.
    if (model !== undefined && providerIdOf(model) === undefined) return { kind: 'ready' }

    const server = await options.controlServer.ensure()
    if (!server.ok) {
      return { kind: 'check-failed', detail: `control server: ${server.reason}` }
    }

    let effectiveModel = model
    if (effectiveModel === undefined) {
      // #597 T3b: `opencode run` picks a model from its own configuration
      // when a launch names none — resolved for THIS launch's folder, since
      // a project `opencode.json` there can override the global default.
      const config = await readConfiguredModel(
        options.fetch,
        server.url,
        server.readPassword(),
        directory
      )
      if (!config.ok) {
        return { kind: 'check-failed', detail: `GET /config: ${config.reason}` }
      }
      effectiveModel = config.model
      // Nothing configured, or a shape this app cannot read a provider out
      // of: the CLI's own free default, same reading an explicit model gets.
      if (effectiveModel === undefined || providerIdOf(effectiveModel) === undefined) {
        return { kind: 'ready' }
      }
    }

    const read = await readConnectedProviders(options.fetch, server.url, server.readPassword())
    if (!read.ok) {
      return { kind: 'check-failed', detail: `GET /provider: ${read.reason}` }
    }
    return decideOpenCodeCredential(effectiveModel, read.connected)
  }
}
