// B-M32 `asking.setStep` (14 §2.3, §3.4 `SetAskStepParams`, frozen; ADR-010 item 9; ADR-003 items
// 6, 12; OQ-03, PO #92): the step a person is on while walking a multi-step question, handed to the
// ask broker's `setStep` (16 §4.7 row `setStep`). UI main's A-N07 `setAskStep` relays it
// (ui-main/ipc/handlers/setAskStep.host.ts, routed by the cut-2 switch, later: ISSUE-141). Nothing
// registers it yet: the composition root registers it over the asking module with the wiring
// (later: ISSUE-140).
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - Not mutating (14 §1.6, dedupe/mutatingMethods.ts): idempotent by its own shape, so no
//   requestId; the same step again changes nothing.
// - The params are the contract's strict() schema (INVALID_PARAMS otherwise, before the handler
//   runs): an askId and a whole non-negative step, never a pick (OQ-03).
// - The result is `{}` for every valid call, an ask that closed meanwhile, an unknown or a queued
//   one included: the broker's silent no-op, never an error (14 §2.3 B-M32; 16 §2.1). A step that
//   moved the front ask publishes `AskStepChanged`, projected as `ask.step` to every `ui`
//   connection (frames/askFrames.ts).
import { HOST_METHOD_SCHEMAS, type HostMethods } from '@dwarfai/contracts'
import type { AskBroker } from '../../modules/asking'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface AskingSetStepDeps {
  broker: Pick<AskBroker, 'setStep'>
}

/** Serves `asking.setStep` (B-M32) on `dispatcher`. */
export function registerAskingSetStep(dispatcher: Dispatcher, deps: AskingSetStepDeps): void {
  dispatcher.register(
    'asking.setStep',
    HOST_METHOD_SCHEMAS['asking.setStep'].params,
    METHOD_ROLES['asking.setStep'] ?? [],
    (params): HostMethods['asking.setStep']['result'] => {
      deps.broker.setStep(params.askId, params.step)
      return {}
    }
  )
}
