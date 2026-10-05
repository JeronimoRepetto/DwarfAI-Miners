// `LedgerCommands.creditUsage(o)` and `LedgerQueries.totals(mineId)` (16 §4.10; 09 §5.3; UC-007).
//
// One call stores the observation by its `sourceKey` (a stored key answers `'duplicate'`: no row,
// no event, INV-90), seals or extends its unit, and credits the unit once if it is now creditable
// (`'credited'`); otherwise the observation is kept (`'stored'`): not sealed yet, already credited
// (INV-91), before the install moment, a reset saga open (INV-97), the mine never measured
// (INV-94; credited later by `creditSealedUnits`), or not from the session's authoritative path
// (INV-92). The material is the mine's tier, never the caller's (INV-94), never coal (INV-95).
//
// The path an observation arrived by is the route's: `UsageObserved` through the observation
// batch is the transcript path, `DriverUsageReported` the driver path (11 F2). Package gap: 16
// §4.10's `creditUsage(o)` names no path and `UsageObservation` (ADR-006 item 4) carries none, so
// the module hands each route its own `LedgerCommands`, bound to that path (`commandsFor`).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { UsageObservation } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { UsagePath } from '../domain/credit'
import type { MaterialTotals } from '../domain/materials'
import type { Crediting } from './crediting'

export function creditUsage(
  crediting: Crediting,
  path: UsagePath,
  o: UsageObservation
): 'credited' | 'stored' | 'duplicate' {
  return crediting.run(() => {
    const store = crediting.deps.stores[path]
    const subject = store.subjectOf(o.dwarfId as DwarfId)
    if (subject === null) {
      throw new HostInvariantError(
        'creditUsage for a dwarf the database does not hold; usage is routed only for bound dwarfs (UC-007 preconditions)'
      )
    }
    if (store.record(o, subject.mineId) === 'duplicate') return 'duplicate'
    return crediting.creditIfCreditable(o.unitKey) ? 'credited' : 'stored'
  })
}

/** `LedgerQueries.totals`: the mine's six materials, each its own count (INV-93). */
export function totals(crediting: Crediting, mineId: MineId): MaterialTotals {
  return crediting.store.totals(mineId)
}
