// B-M34 `launching.launchCustom` (14 §2.3, §3.4 `LaunchCustomParams` / `LaunchAccepted`, frozen;
// 14 §1.7; ADR-020 item 3): "Other…" — the person's own command sent in — as a Host command, handed
// to the launching module's `LaunchCommands.launchCustom` (ISSUE-165). UI main's A-39 relays it once
// the step-3d route switch moves it to the Host (later: ISSUE-186); until then it stays `legacy`.
// The launching wiring registers it (wiring/routes/launching.ts `serveLaunching`).
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - Mutating (14 §1.6): one launch per `requestId` on a connection; a repeat gets the first answer
//   from the dispatcher's table and launches nothing. The `requestId` is the transport's only.
// - The params are the contract's strict() schema (ADR-019): an extra key is INVALID_PARAMS before
//   the handler runs.
// - Answered at acceptance (14 §1.7), exactly like B-M33. A command `parseHostedCommand` refuses is
//   accepted and settles `launch.failed{could-not-start}` with nothing spawned (ADR-020 item 3):
//   only a request refused before any row is written (INV-50, INV-54) is INVALID_PARAMS.
// - The params are sensitive (14 §3.5 SENSITIVE_METHODS: the prompt and the custom command). The
//   dispatcher logs the method name, outcome and code only, and nothing here logs.
import { HOST_METHOD_SCHEMAS, type LaunchAccepted } from '@dwarfai/contracts'
import { LaunchRefusedError, type LaunchingCommands } from '../../modules/launching'
import { CallError, type Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface LaunchingLaunchCustomDeps {
  launching: Pick<LaunchingCommands, 'launchCustom'>
}

/** Serves `launching.launchCustom` (B-M34) on `dispatcher`. */
export function registerLaunchingLaunchCustom(
  dispatcher: Dispatcher,
  deps: LaunchingLaunchCustomDeps
): void {
  dispatcher.registerMutating(
    'launching.launchCustom',
    HOST_METHOD_SCHEMAS['launching.launchCustom'].params,
    METHOD_ROLES['launching.launchCustom'] ?? [],
    async (params): Promise<LaunchAccepted> => {
      const { requestId, ...request } = params
      void requestId
      try {
        return await deps.launching.launchCustom(request)
      } catch (error) {
        if (error instanceof LaunchRefusedError) throw new CallError('INVALID_PARAMS')
        throw error
      }
    }
  )
}
