// The conversation module's step of the Reset-metrics saga (16 §4.12 `ResetDbStep`; ADR-023 items
// 1, 3, 4; 09 §7.2 rows `messages`, `deliveries`, "Answers:" records, `activity_disclosures`,
// `outcome_lines`, `message_keys`). It joins the saga's one `db` transaction (16 §2.2): called
// outside one it throws `HostInvariantError` and writes nothing.
//
// - Every message of every dwarf, live ones included, is deleted, "Answers:" records too, except a
//   message whose delivery is still `sending` (a person message being handed over, or the record
//   of an `answering` ask): it keeps its row and delivery so the hand-over settles normally
//   (ADR-023 item 1 "in-flight items untouched"; 07 S7.19). The other deliveries go by cascade.
// - Every activity run (open ones included) and every outcome line is deleted: a live chat
//   restarts empty from the reset point (INV-61, PO #95).
// - `message_keys` are left as they are (their `message_id` turns NULL by `ON DELETE SET NULL`), so
//   a replay re-imports nothing older than the reset (OQ-32 A). Those of departed dwarfs go with
//   their dwarf in the crew step.
//
// It ends no session (ADR-023 item 3). It satisfies `ResetDbStep` structurally: conversation has no
// edge to `preferences` (05 §1.3, R4); host/wiring/resetParticipants.ts registers it with the saga.
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'

export interface ConversationResetStepDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

const DELETE_MESSAGES = `DELETE FROM messages
  WHERE id NOT IN (SELECT message_id FROM deliveries WHERE phase = 'sending')`

export class ConversationResetStep {
  readonly name = 'conversation'

  constructor(private readonly deps: ConversationResetStepDeps) {}

  reset(tx: TransactionRunner): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        "the conversation ResetDbStep runs inside the saga's db transaction (16 §2.2)"
      )
    }
    tx.inTransaction(() => {
      this.deps.db.run(DELETE_MESSAGES)
      this.deps.db.run('DELETE FROM activity_disclosures')
      this.deps.db.run('DELETE FROM outcome_lines')
    })
  }
}
