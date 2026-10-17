// The launching module's step of the Reset-metrics saga (16 §4.12 `ResetDbStep`; ADR-023 items 1,
// 3-5; 09 §7.2 step (4) and rows "`launches` in flight, `launch_records` and `processes` of present
// dwarfs - kept", "Settled `launches`" and "`host_recovery_reports` / items"; 06 INV-109). It joins
// the saga's one `db` transaction (16 §2.2): called outside one it throws `HostInvariantError` and
// writes nothing.
//
// - It deletes the settled launches that no remaining `launch_records` row references (09 §7.2
//   step (4)). A live owned session's `succeeded` launch is referenced by its record, so it stays
//   and `launch_records.launch_id ... ON DELETE RESTRICT` never fires: the transaction commits while
//   owned sessions run (R4B-01). The step therefore runs after the mines and crew steps of (2),
//   whose cascades take the departed dwarfs' records, and after the delegation step of (3)
//   (resetParticipants.ts). A deleted launch's `processes.launch_id` turns NULL and its
//   `delegation_tokens` row goes by the schema's own FK actions.
// - In-flight launches, every `launch_records` row and every `processes` row are kept: the step
//   never ends a session (INV-109).
// - It deletes the settled recovery reports (`state = 'settled'`, the only state with
//   `settled_at`); their items go by cascade. A report in any other state still owes its answer
//   and is kept (ADR-015).
// - It is idempotent: a second run finds nothing settled to delete.
//
// It satisfies `ResetDbStep` structurally: launching has no edge to `preferences` (05 §1.3, R4);
// host/wiring/resetParticipants.ts registers it with the saga.
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'

export interface LaunchingResetStepDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

/** 09 §7.2 step (4), verbatim. */
const DELETE_SETTLED_LAUNCHES = `DELETE FROM launches WHERE settled_at IS NOT NULL
  AND id NOT IN (SELECT launch_id FROM launch_records)`

const DELETE_SETTLED_REPORTS = `DELETE FROM host_recovery_reports WHERE state = 'settled'`

export class LaunchingResetStep {
  readonly name = 'launching'

  constructor(private readonly deps: LaunchingResetStepDeps) {}

  reset(tx: TransactionRunner): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        "the launching ResetDbStep runs inside the saga's db transaction (16 §2.2)"
      )
    }
    tx.inTransaction(() => {
      this.deps.db.run(DELETE_SETTLED_LAUNCHES)
      this.deps.db.run(DELETE_SETTLED_REPORTS)
    })
  }
}
