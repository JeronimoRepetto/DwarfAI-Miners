// B-M36 `launching.dismissRecovery` (14 §2.3, §3.4 `RecoveryActionParams`, frozen; 16 §4.5; ADR-015
// item 5; OQ-43; CR-13-02): the grouped recovery message's Dismiss as a Host command, handed to the
// launching recovery's `dismissRecovery`. UI main's A-N11 relays it (the route switch of cut 3a,
// later: ISSUE-001). The launching wiring registers it (wiring/routes/launching.ts `serveLaunching`).
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - Mutating (14 §1.6): one dismissal per `requestId` on a connection; a repeat gets the first
//   answer from the dispatcher's table.
// - The params are the contract's strict() schema (ADR-019): an extra key is INVALID_PARAMS.
// - The result is 14 §3.4's `Outcome<{}, 'no-report'>`: `{}` once the items settled and the
//   still-unrecovered dwarfs' walk-out was published (`RecoveryDismissed`, its `host.recovered` frame
//   enqueued before this answer), `no-report` when that epoch has no unsettled report.
import { HOST_METHOD_SCHEMAS, type Outcome } from '@dwarfai/contracts'
import type { LaunchingRecovery } from '../../modules/launching'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface LaunchingDismissRecoveryDeps {
  recovery: Pick<LaunchingRecovery, 'dismissRecovery'>
}

/** Serves `launching.dismissRecovery` (B-M36) on `dispatcher`. */
export function registerLaunchingDismissRecovery(
  dispatcher: Dispatcher,
  deps: LaunchingDismissRecoveryDeps
): void {
  dispatcher.registerMutating(
    'launching.dismissRecovery',
    HOST_METHOD_SCHEMAS['launching.dismissRecovery'].params,
    METHOD_ROLES['launching.dismissRecovery'] ?? [],
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty value as {}
    (params): Outcome<{}, 'no-report'> => {
      const result = deps.recovery.dismissRecovery(params.hostEpoch, params.requestId)
      return result.ok ? { ok: true, value: {} } : { ok: false, error: 'no-report' }
    }
  )
}
