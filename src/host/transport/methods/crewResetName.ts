// B-M23 `crew.resetName` (14 §2.3, §3.4 `ResetDwarfNameParams`, frozen; 16 §4.2; UC-034): Reset
// name, with no confirmation (US-MSG-006.AC03), handed to `CrewCommands.resetName`. UI main's A-N09
// `resetDwarfName` relays it once the step-3a switch routes that row (later: ISSUE-001). The crew
// wiring registers it (host/wiring/routes/crew.ts `serveCrew`).
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - Mutating (14 §1.6, dedupe/mutatingMethods.ts): a repeated `requestId` gets the first answer with
//   no second reset.
// - The params are the contract's strict() schema; a dwarf the Host never stored is INVALID_PARAMS
//   before crew runs. The result is `{}`, also for a dwarf with no custom name or one that departed
//   meanwhile (16 §2.1: a race is a silent no-op).
import { HOST_METHOD_SCHEMAS, type HostMethods } from '@dwarfai/contracts'
import type { DwarfId } from '../../kernel/domain/values'
import type { CrewCommands, CrewQueries } from '../../modules/crew'
import { CallError, type Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface CrewResetNameDeps {
  commands: Pick<CrewCommands, 'resetName'>
  queries: Pick<CrewQueries, 'get'>
}

/** Serves `crew.resetName` (B-M23) on `dispatcher`. */
export function registerCrewResetName(dispatcher: Dispatcher, deps: CrewResetNameDeps): void {
  dispatcher.registerMutating(
    'crew.resetName',
    HOST_METHOD_SCHEMAS['crew.resetName'].params,
    METHOD_ROLES['crew.resetName'] ?? [],
    (params): HostMethods['crew.resetName']['result'] => {
      const dwarfId = params.dwarfId as string as DwarfId
      if (deps.queries.get(dwarfId) === null) throw new CallError('INVALID_PARAMS')
      deps.commands.resetName(dwarfId)
      return {}
    }
  )
}
