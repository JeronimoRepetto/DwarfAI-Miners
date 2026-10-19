// The asking module's step of the Reset-metrics saga (16 §4.12 `ResetDbStep`; ADR-023 items 1, 3,
// 4; 09 §7.2 row "`asks` open or answering, their `ask_answers`": kept; closed asks deleted, their
// `ask_answers` and `attention_keys` cascade). It joins the saga's one `db` transaction (16 §2.2):
// called outside one it throws `HostInvariantError` and writes nothing.
//
// - An `open` ask keeps its card and its step; an `answering` ask keeps its pending `ask_answers`
//   row, so the hand-over settles normally when its channel answers. No session is ended.
// - It runs before the attention step (resetParticipants.ts): the cascade takes the closed asks'
//   keys, and attention then finds only the keys that remain.
//
// It satisfies `ResetDbStep` structurally: the asking module has no edge to `preferences`
// (05 §1.3, R4); host/wiring/resetParticipants.ts registers it with the saga.
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'

export interface AskingResetStepDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

const DELETE_CLOSED_ASKS = `DELETE FROM asks WHERE state NOT IN ('open', 'answering')`

export class AskingResetStep {
  readonly name = 'asking'

  constructor(private readonly deps: AskingResetStepDeps) {}

  reset(tx: TransactionRunner): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        "the asking ResetDbStep runs inside the saga's db transaction (16 §2.2)"
      )
    }
    tx.inTransaction(() => {
      this.deps.db.run(DELETE_CLOSED_ASKS)
    })
  }
}
