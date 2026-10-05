// The crew module's step of the Reset-metrics saga (16 §4.12 `ResetDbStep`; ADR-023 items 1, 3,
// 4; 09 §7.2 rows `dwarfs`, `dwarf_lifecycle_facts`). It joins the saga's one `db` transaction
// (16 §2.2): called outside one it throws `HostInvariantError` and writes nothing.
//
// - Every dwarf that left, in any mine, is deleted: the history is wiped (ADR-023 item 1, PO #25),
//   and its rows go by cascade (its lifecycle facts, launch record, messages, asks, usage).
// - A present dwarf is kept, id, rank, provider identity and process facts untouched (INV-109),
//   and its custom name returns to none (ADR-023 item 3). Its lifecycle facts stay, so its
//   provider keys keep deduping (09 §7.2, ADR-006 item 1).
//
// It satisfies `ResetDbStep` structurally: crew has no edge to `preferences` (05 §1.3, R4).
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'

export interface CrewResetStepDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

export class CrewResetStep {
  readonly name = 'crew'

  constructor(private readonly deps: CrewResetStepDeps) {}

  reset(tx: TransactionRunner): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        "the crew ResetDbStep runs inside the saga's db transaction (16 §2.2)"
      )
    }
    tx.inTransaction(() => {
      this.deps.db.run('DELETE FROM dwarfs WHERE departed_at IS NOT NULL')
      this.deps.db.run('UPDATE dwarfs SET custom_name = NULL WHERE custom_name IS NOT NULL')
    })
  }
}
