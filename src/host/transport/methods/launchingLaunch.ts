// B-M33 `launching.launch` (14 §2.3, §3.4 `LaunchParams` / `LaunchAccepted`, frozen; 14 §1.7;
// ADR-020): "Send the dwarf in" as a Host command, handed to the launching module's
// `LaunchCommands.launch`. UI main's A-35 relays it (the route switch of cut 3a, later: ISSUE-001).
// The launching wiring registers it (wiring/routes/launching.ts `serveLaunching`).
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - Mutating (14 §1.6): one launch per `requestId` on a connection; a repeat gets the first answer
//   from the dispatcher's table and launches nothing. The `requestId` is the transport's only: it is
//   not part of the module's `LaunchRequestInput` (16 §4.5 idempotency "requestId at transport").
// - The params are the contract's strict() schema (ADR-019): an extra key, here or inside `way`, is
//   INVALID_PARAMS before the handler runs.
// - Answered at acceptance (14 §1.7): `LaunchAccepted { launchId }` once the `launches` row is
//   committed and `LaunchRequested` published, its `launch.changed` frame enqueued before this
//   answer; the settlement arrives only as `launch.changed` / `launch.failed`. A request the Host
//   refuses before any row is written (INV-50; a permission mode not offered now, ADR-011 item 1;
//   a Retry of nothing retryable, INV-54; the Jev path, not built yet) is INVALID_PARAMS: there
//   is no failure result at acceptance (16 §4.5).
// - The params are sensitive (14 §3.5 SENSITIVE_METHODS: the prompt). The dispatcher logs the
//   method name, outcome and code only, and nothing here logs.
import { HOST_METHOD_SCHEMAS, type LaunchAccepted } from '@dwarfai/contracts'
import { LaunchRefusedError, type LaunchingCommands } from '../../modules/launching'
import { CallError, type Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface LaunchingLaunchDeps {
  launching: Pick<LaunchingCommands, 'launch'>
}

/** Serves `launching.launch` (B-M33) on `dispatcher`. */
export function registerLaunchingLaunch(dispatcher: Dispatcher, deps: LaunchingLaunchDeps): void {
  dispatcher.registerMutating(
    'launching.launch',
    HOST_METHOD_SCHEMAS['launching.launch'].params,
    METHOD_ROLES['launching.launch'] ?? [],
    async (params): Promise<LaunchAccepted> => {
      const { requestId, ...request } = params
      void requestId
      try {
        return await deps.launching.launch(request)
      } catch (error) {
        if (error instanceof LaunchRefusedError) throw new CallError('INVALID_PARAMS')
        throw error
      }
    }
  )
}
