// `LedgerCommands.creditSealedUnits(mineId)` (16 §4.10, AMENDMENT-10, OQ-78): the route of
// `MineMeasured` (08 §2.1; later: ISSUE-096). Now that the mine's tier is known, every stored,
// sealed unit of the mine without a credit (`usage_units_mine_sealed`) is credited once, in one
// transaction, through the same gates as `creditUsage` (INV-94); a unit already credited is
// skipped, so a second call credits none. `MaterialCredited` and `LedgerTotalsChanged` follow the
// commit.
import type { MineId } from '../../../kernel/domain/values'
import type { Crediting } from './crediting'

export function creditSealedUnits(crediting: Crediting, mineId: MineId): { credited: number } {
  return crediting.run(() => {
    let credited = 0
    for (const unitKey of crediting.repository.sealedUncredited(mineId)) {
      if (crediting.creditIfCreditable(unitKey)) credited += 1
    }
    return { credited }
  })
}
