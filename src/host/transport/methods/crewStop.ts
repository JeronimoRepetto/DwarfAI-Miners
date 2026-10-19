// B-M21 `crew.stop` (14 §2.3, §3.4 `StopDwarfParams`, `StopDwarfResult`, frozen; 16 §4.2;
// AMENDMENT-2, OQ-54; ADR-014; UC-019): "Stop dwarf…" ends the dwarf's whole session, handed to
// `CrewCommands.stop`. UI main's A-N29 `stopDwarf` relays it once the step-3a switch routes that row
// (later: ISSUE-001). The crew wiring registers it (host/wiring/routes/crew.ts `serveCrew`).
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - Mutating (14 §1.6, dedupe/mutatingMethods.ts): a repeated `requestId` gets the first answer with
//   no second stop.
// - Answered once the end settled (14 §1.7 "effects before response"; 14 §3.10: `crew.stop` 60 s):
//   `{}` after the dwarf departed, else `'already-stopping'` (a stop in flight) or `'could-not-end'`
//   (the dwarf stays, still running, and its one `toast {dwarf-stop-failed}` was enqueued first).
//   An open turn is not a refusal (AMENDMENT-2, OQ-54).
// - The params are the contract's strict() schema; a dwarf the Host never stored is INVALID_PARAMS
//   before crew runs.
import { HOST_METHOD_SCHEMAS, type HostMethods } from '@dwarfai/contracts'
import type { DwarfId } from '../../kernel/domain/values'
import type { CrewQueries, CrewStops } from '../../modules/crew'
import { CallError, type Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface CrewStopDeps {
  stops: Pick<CrewStops, 'stop'>
  queries: Pick<CrewQueries, 'get'>
}

/** Serves `crew.stop` (B-M21) on `dispatcher`. */
export function registerCrewStop(dispatcher: Dispatcher, deps: CrewStopDeps): void {
  dispatcher.registerMutating(
    'crew.stop',
    HOST_METHOD_SCHEMAS['crew.stop'].params,
    METHOD_ROLES['crew.stop'] ?? [],
    async (params): Promise<HostMethods['crew.stop']['result']> => {
      const dwarfId = params.dwarfId as string as DwarfId
      if (deps.queries.get(dwarfId) === null) throw new CallError('INVALID_PARAMS')
      const stopped = await deps.stops.stop(dwarfId, params.requestId)
      return stopped.ok ? { ok: true, value: {} } : stopped
    }
  )
}
