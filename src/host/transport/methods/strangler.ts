// B-M41 `strangler.dwarfIdentities` (14 §2.3, §3.4 `StranglerDwarfIdentity`, §1.10 "Strangler-only
// read", §5 `LegacyDwarfIdBridge`; AMENDMENT-8, OQ-69): the exact join source of the legacy id
// bridge, one `(DwarfId, ProviderId, ProviderIdentity)` record per present dwarf, read from crew's
// strangler-only `presentIdentities()` (05 §3.2; ADR-015 item 7). host/wiring/routes/crew.ts registers it
// before the boot binds the endpoint, over the crew instance boot step 4 wires (ISSUE-094).
//
// - `ui` only (roles.ts): a `notifier` or `viewer` gets FORBIDDEN before the handler runs
//   (ADR-003 item 12). Its only caller is `LegacyDwarfIdBridge` in Electron main.
// - Read-only: no requestId, no effect, no frame. Its result is never relayed to seam A: no
//   preload member, no push, no renderer store holds it (14 §1.10).
// - Deleted together with `LegacyDwarfIdBridge` and `presentIdentities` at the end of cut 4
//   (later: ISSUE-241); a build after cut 4 answers METHOD_NOT_FOUND (14 §6.5 AMENDMENT-8).
import { HOST_METHOD_SCHEMAS, type HostMethods } from '@dwarfai/contracts'
import type { CrewQueries } from '../../modules/crew'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface StranglerMethodsDeps {
  crew: Pick<CrewQueries, 'presentIdentities'>
}

/** Serves `strangler.dwarfIdentities` (B-M41) on `dispatcher`. */
export function registerStranglerDwarfIdentities(
  dispatcher: Dispatcher,
  deps: StranglerMethodsDeps
): void {
  dispatcher.register(
    'strangler.dwarfIdentities',
    HOST_METHOD_SCHEMAS['strangler.dwarfIdentities'].params,
    METHOD_ROLES['strangler.dwarfIdentities'] ?? [],
    (): HostMethods['strangler.dwarfIdentities']['result'] =>
      deps.crew.presentIdentities().map(({ dwarfId, providerId, identity }) => ({
        dwarfId,
        providerId,
        identity
      }))
  )
}
