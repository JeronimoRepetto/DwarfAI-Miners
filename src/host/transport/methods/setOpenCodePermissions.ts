// B-M14 `preferences.setOpenCodePermissions` (14 §2.3, §3.4; ADR-011 item 7; ADR-016 items 1, 5–7;
// 16 §4.12, §7.4; UC-028). host/wiring/preferencesWiring.ts registers it (ISSUE-228).
//
// - B-M14 is `ui` only (roles.ts; a `notifier` gets FORBIDDEN) and mutating: a repeated `requestId`
//   gets the first answer with no second effect (dispatcher.ts, 14 §1.6). Its params are the
//   contract's strict() schema, `{ on, origin, requestId }`, and the origin is the wire's: `settings`
//   (the Settings toggle) or `add-panel` (the Add panel's notice action, PO #104). `first-run` is
//   INVALID_PARAMS: only B-M40 consents for the first-run step (AMENDMENT-7).
// - It answers the module's stored state after the write and read-back, or the revert, settled
//   (14 §1.7): the Add panel sends its launch only after this answer (ADR-011 item 7, 05 §3.12 "two
//   commands, never one"). `config-write-failed` and `config-revert-failed` are outcomes of the
//   result, never call errors (14 §3.4 `SetOpenCodePermissionsResult`).
// - `IntegrationChanged`, published by the module after every outcome, becomes B-F25
//   `integration.changed` through the route setClaudeHooks.ts `publishIntegrationChanged` already
//   serves for every integration (wiring/routes/preferencesRoutes.ts), so the frame precedes the
//   `res`. The frame carries the consent origin while the integration is on; never a token.
import { HOST_METHOD_SCHEMAS, type HostMethods } from '@dwarfai/contracts'
import type { PreferencesCommands } from '../../modules/preferences'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface SetOpenCodePermissionsMethodDeps {
  commands: Pick<PreferencesCommands, 'setOpenCodePermissions'>
}

/** Serves `preferences.setOpenCodePermissions` (B-M14) on `dispatcher`, with the wire's origin. */
export function registerSetOpenCodePermissions(
  dispatcher: Dispatcher,
  deps: SetOpenCodePermissionsMethodDeps
): void {
  dispatcher.registerMutating(
    'preferences.setOpenCodePermissions',
    HOST_METHOD_SCHEMAS['preferences.setOpenCodePermissions'].params,
    METHOD_ROLES['preferences.setOpenCodePermissions'] ?? [],
    (params): Promise<HostMethods['preferences.setOpenCodePermissions']['result']> =>
      deps.commands.setOpenCodePermissions(params.on, params.origin)
  )
}
