// B-M22 `crew.rename` (14 §2.3, §3.4 `RenameDwarfParams`, `RenameDwarfResult`, frozen; 16 §4.2;
// AMENDMENT-2, SC-AR-05; UC-034): a dwarf's custom name, handed to `CrewCommands.rename`. UI main's
// A-N08 `renameDwarf` relays it once the step-3a switch routes that row (later: ISSUE-001). The crew
// wiring registers it (host/wiring/routes/crew.ts `serveCrew`).
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - Mutating (14 §1.6, dedupe/mutatingMethods.ts): a repeated `requestId` gets the first answer with
//   no second rename.
// - The params are the contract's strict() schema; the Host re-checks the name after UI main
//   (NFR-SEC-08): a name above 24 grapheme clusters once normalized (06 `DwarfName`), or a dwarf
//   the Host never stored, is INVALID_PARAMS before crew runs. Nothing left of the text is the
//   `'empty'` outcome and a name equal to the base name answers `customName: null`, both results,
//   never call errors.
// - Its params are sensitive (14 §3.5 SENSITIVE_METHODS): the dispatcher logs the method name,
//   outcome and code only, and nothing here logs (INV-29: a custom name is never logged).
import { HOST_METHOD_SCHEMAS, type HostMethods } from '@dwarfai/contracts'
import type { DwarfId } from '../../kernel/domain/values'
import { normalizeDwarfName, type CrewCommands, type CrewQueries } from '../../modules/crew'
import { CallError, type Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface CrewRenameDeps {
  commands: Pick<CrewCommands, 'rename'>
  queries: Pick<CrewQueries, 'get'>
}

/** Serves `crew.rename` (B-M22) on `dispatcher`. */
export function registerCrewRename(dispatcher: Dispatcher, deps: CrewRenameDeps): void {
  dispatcher.registerMutating(
    'crew.rename',
    HOST_METHOD_SCHEMAS['crew.rename'].params,
    METHOD_ROLES['crew.rename'] ?? [],
    (params): HostMethods['crew.rename']['result'] => {
      const dwarfId = params.dwarfId as string as DwarfId
      if (deps.queries.get(dwarfId) === null || !normalizeDwarfName(params.name).ok) {
        throw new CallError('INVALID_PARAMS')
      }
      const answer = deps.commands.rename(dwarfId, params.name)
      return answer.ok ? { ok: true, value: { customName: answer.value } } : answer
    }
  )
}
