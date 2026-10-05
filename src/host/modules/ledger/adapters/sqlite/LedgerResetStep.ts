// The ledger module's step of the Reset-metrics saga (16 §4.12 `ResetDbStep`; ADR-023 items 1, 2,
// 4; ADR-006 item 9; 09 §7.2 rows `usage_units`, `usage_observations`, `ledger_entries`,
// `material_totals`, `install_moment`). It joins the saga's one `db` transaction (16 §2.2): called
// outside one it throws `HostInvariantError` and writes nothing.
//
// Every usage unit and observation, every ledger entry and total (the retained ledgers of removed
// mines included) and the install moment are deleted; `coal_backfill_units` goes with the install
// moment by cascade. The saga's own `install-moment` step writes `(now, 'reset')` later, in its
// own transaction (07 S13.05). The entries go before the totals: their delete trigger
// (`ledger_entries_withdraw`) adjusts totals that are then deleted, so no total outlives its
// entries.
//
// It satisfies `ResetDbStep` structurally: the ledger has no edge to `preferences` (05 §1.3, R4).
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'

export interface LedgerResetStepDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

const WIPE = [
  'DELETE FROM usage_observations',
  'DELETE FROM usage_units',
  'DELETE FROM ledger_entries',
  'DELETE FROM material_totals',
  'DELETE FROM install_moment'
] as const

export class LedgerResetStep {
  readonly name = 'ledger'

  constructor(private readonly deps: LedgerResetStepDeps) {}

  reset(tx: TransactionRunner): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        "the ledger ResetDbStep runs inside the saga's db transaction (16 §2.2)"
      )
    }
    tx.inTransaction(() => {
      for (const statement of WIPE) this.deps.db.run(statement)
    })
  }
}
