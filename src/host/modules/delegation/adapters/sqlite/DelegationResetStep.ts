// The delegation module's step of the Reset-metrics saga (16 §4.12 `ResetDbStep`; ADR-023 items 1,
// 3-4; 09 §7.2 rows "`delegations` in flight, `delegation_tokens` - kept" and "Settled
// `delegations` - deleted"; 06 INV-109). It joins the saga's one `db` transaction (16 §2.2): called
// outside one it throws `HostInvariantError` and writes nothing.
//
// - It deletes the settled delegations (`succeeded`, `failed`) and nothing else: an `attempted` or
//   `running` delegation keeps its row, so its worker runs to its result; every `delegation_tokens`
//   row is kept (the tokens belong to launches, not to the delegation rows).
// - A deleted delegation nulls `launches.delegation_id` of its worker launch (`ON DELETE SET
//   NULL`); no `launches` CHECK reads that FK, they read `launches.delegated` (V4-01), so the
//   transaction commits. The step therefore runs before the launching step that deletes the
//   settled launches (09 §7.2 (4); resetParticipants.ts).
// - It is idempotent: a second run finds no settled delegation.
//
// It satisfies `ResetDbStep` structurally: the delegation module has no edge to `preferences`
// (05 §1.3, R4); host/wiring/resetParticipants.ts registers it with the saga.
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'

export interface DelegationResetStepDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

const DELETE_SETTLED = `DELETE FROM delegations WHERE state IN ('succeeded', 'failed')`

export class DelegationResetStep {
  readonly name = 'delegation'

  constructor(private readonly deps: DelegationResetStepDeps) {}

  reset(tx: TransactionRunner): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        "the delegation ResetDbStep runs inside the saga's db transaction (16 §2.2)"
      )
    }
    tx.inTransaction(() => {
      this.deps.db.run(DELETE_SETTLED)
    })
  }
}
