// B-M10 `settings.secret.set` and B-M11 `settings.secret.clear` (14 §2.3, §3.4 `SecretSetParams`,
// `SecretStatusResult`, frozen; 16 §4.12 `saveSecret`, `clearSecret`; ADR-017 items 4, 5; ADR-003
// item 11; UC-029). UI main's A-48/A-49 and A-54/A-55 relay them once their rows are routed (later:
// ISSUE-217, ISSUE-231); the preferences wiring registers them.
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - Mutating (14 §1.6, dedupe/mutatingMethods.ts): a repeated `requestId` gets the first answer with
//   no second write.
// - The params are the contract's strict() schemas: a name other than a `SecretName`, an extra
//   field, an empty or oversized value is INVALID_PARAMS before the module runs. `origin`
//   (`settings` or the one-time `migration`, ADR-017 item 8) changes nothing here.
// - The value travels once, one way: it is handed to `saveSecret` and never answered, published or
//   validated (INV-107; 18 C-22). The answer is the configured flag only. B-M10 answers the outcome
//   `'backend-unavailable'` when the save left the secret unconfigured, which happens only when no
//   secret service is usable: nothing was written anywhere (ADR-017 item 5, no plain-text
//   fallback). B-M11 always answers the flag: a clear with no secret service is a successful no-op
//   (AMENDMENT-2).
// - Both members' params are sensitive (14 §3.5 SENSITIVE_METHODS): the dispatcher logs the method
//   name, outcome and code only, and nothing here logs (NFR-SEC-12).
import { HOST_METHOD_SCHEMAS, type HostMethods } from '@dwarfai/contracts'
import type { SecretCommands } from '../../modules/preferences'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface SettingsSecretDeps {
  commands: SecretCommands
}

/** Serves `settings.secret.set` (B-M10) and `settings.secret.clear` (B-M11) on `dispatcher`. */
export function registerSettingsSecret(dispatcher: Dispatcher, deps: SettingsSecretDeps): void {
  const { commands } = deps
  dispatcher.registerMutating(
    'settings.secret.set',
    HOST_METHOD_SCHEMAS['settings.secret.set'].params,
    METHOD_ROLES['settings.secret.set'] ?? [],
    async (params): Promise<HostMethods['settings.secret.set']['result']> => {
      const status = await commands.saveSecret(params.name, params.value)
      return status.configured
        ? { ok: true, value: { name: status.name, configured: true } }
        : { ok: false, error: 'backend-unavailable' }
    }
  )
  dispatcher.registerMutating(
    'settings.secret.clear',
    HOST_METHOD_SCHEMAS['settings.secret.clear'].params,
    METHOD_ROLES['settings.secret.clear'] ?? [],
    async (params): Promise<HostMethods['settings.secret.clear']['result']> => {
      const status = await commands.clearSecret(params.name)
      return { ok: true, value: { name: status.name, configured: status.configured } }
    }
  )
}
