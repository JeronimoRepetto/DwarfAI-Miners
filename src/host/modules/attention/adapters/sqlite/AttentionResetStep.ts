// The attention module's step of the Reset-metrics saga (16 §4.12 `ResetDbStep`; ADR-023 items 1,
// 4; 09 §7.2 rows `attention_keys`, `attention_announced`: "kept for open asks of present dwarfs;
// others deleted (turn keys, suppressed or emitted, included)"). It joins the saga's one `db`
// transaction (16 §2.2): called outside one it throws `HostInvariantError` and writes nothing.
//
// - A key survives only when its `ask_id` names an `open` or `answering` ask of a present dwarf
//   (`departed_at IS NULL`, the 09 `dwarfs_crew` predicate), so a need still live is never
//   announced again (INV-100) and every past notification record goes. Turn keys name no ask and
//   always go.
// - A carry-over row survives only for a present dwarf with an open or answering ask of the same
//   kind: the re-raised need it waits for may still arrive (07 S6.19).
//
// It satisfies `ResetDbStep` structurally: the attention module has no edge to `preferences`
// (05 §1.3, R4); host/wiring/resetParticipants.ts registers it with the saga. It reads no other
// module's table through a port: the predicate is part of the one SQL statement of each deletion,
// the 09 §7.2 rule written against the schema the step runs in.
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'

export interface AttentionResetStepDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

/** The asks still live (open or being answered) of a dwarf still present. */
const LIVE_ASKS = `SELECT asks.id, asks.dwarf_id, asks.kind FROM asks
  JOIN dwarfs ON dwarfs.id = asks.dwarf_id
  WHERE asks.state IN ('open', 'answering') AND dwarfs.departed_at IS NULL`

const DELETE_KEYS = `DELETE FROM attention_keys
  WHERE ask_id IS NULL OR ask_id NOT IN (SELECT id FROM (${LIVE_ASKS}))`

const DELETE_CARRY_OVER = `DELETE FROM attention_announced WHERE NOT EXISTS (
  SELECT 1 FROM (${LIVE_ASKS}) AS live
  WHERE live.dwarf_id = attention_announced.dwarf_id AND live.kind = attention_announced.kind)`

export class AttentionResetStep {
  readonly name = 'attention'

  constructor(private readonly deps: AttentionResetStepDeps) {}

  reset(tx: TransactionRunner): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        "the attention ResetDbStep runs inside the saga's db transaction (16 §2.2)"
      )
    }
    tx.inTransaction(() => {
      this.deps.db.run(DELETE_KEYS)
      this.deps.db.run(DELETE_CARRY_OVER)
    })
  }
}
