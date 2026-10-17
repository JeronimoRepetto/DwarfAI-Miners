// B-M35 `launching.retryRecovery` (14 §2.3, §3.4 `RecoveryActionParams`, frozen; 16 §4.5; ADR-015
// item 5; OQ-41 A): the grouped recovery message's Retry as a Host command, handed to the launching
// recovery's `retryRecovery`. UI main's A-N10 relays it (the route switch of cut 3a, later: ISSUE-001).
// The launching wiring registers it (wiring/routes/launching.ts `serveLaunching`), over the routed
// command that re-sends the settled report's `host.recovered` frame before this answer.
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - Mutating (14 §1.6): one retry per `requestId` on a connection; a repeat gets the first answer
//   from the dispatcher's table. A second Retry while one runs answers that same retry (one action
//   for the group, 07 S16.05). The `requestId` reaches the module: `RecoveryRetried` carries it (08 §0).
// - The params are the contract's strict() schema (ADR-019): an extra key is INVALID_PARAMS.
// - The result is 14 §3.4's `Outcome<HostRecoveryReportView, 'no-report'>`: the settled report once
//   every retried resume settled, or `no-report` when that epoch has no unsettled report. Never a
//   call error for either.
// - Nothing here logs: the report names dwarfs and provider causes (14 §3.5).
import { HOST_METHOD_SCHEMAS, type HostRecoveryReportView, type Outcome } from '@dwarfai/contracts'
import type { LaunchingRecovery } from '../../modules/launching'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'
import { toHostRecoveryReportView } from '../snapshot/recoverySection'

export interface LaunchingRetryRecoveryDeps {
  recovery: Pick<LaunchingRecovery, 'retryRecovery'>
}

/** Serves `launching.retryRecovery` (B-M35) on `dispatcher`. */
export function registerLaunchingRetryRecovery(
  dispatcher: Dispatcher,
  deps: LaunchingRetryRecoveryDeps
): void {
  dispatcher.registerMutating(
    'launching.retryRecovery',
    HOST_METHOD_SCHEMAS['launching.retryRecovery'].params,
    METHOD_ROLES['launching.retryRecovery'] ?? [],
    async (params): Promise<Outcome<HostRecoveryReportView, 'no-report'>> => {
      const result = await deps.recovery.retryRecovery(params.hostEpoch, params.requestId)
      return result.ok
        ? { ok: true, value: toHostRecoveryReportView(result.value) }
        : { ok: false, error: 'no-report' }
    }
  )
}
