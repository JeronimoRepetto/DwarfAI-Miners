// The asks maintenance sweep (09 §7.1 row `asks`, `ask_answers`; ADR-010, PO #91): a closed ask
// is deleted 7 days after its `closed_at`; its `ask_answers` and `attention_keys` rows go with it
// (`ON DELETE CASCADE`) and the "Answers:" record's `messages.ask_id` becomes NULL (`ON DELETE SET
// NULL`). An `open` or `answering` ask has no `closed_at` (the `asks` CHECK) and is never swept.
// "Older than 7 days" is strict: an ask closed exactly 7 days ago waits for the next sweep. Time
// comes from the kernel `Clock`, read once per sweep. Each statement deletes at most
// `ASK_SWEEP_BATCH` rows in its own transaction, so the single writer is never held long
// (09 §8.1); the sweep repeats until a statement deletes fewer. It is SQL over the schema, not a
// method of the frozen `AskRepository` port (16 §4.7); when it runs is the composition's choice
// (the maintenance tick, 09 §7.1).
import type { Clock } from '../../../kernel/ports/clock'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'

/** 09 §7.1: closed asks are kept 7 days after `closed_at`. */
export const CLOSED_ASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Rows deleted per statement (09 §7.1: bounded to 1 000 rows per statement). */
export const ASK_SWEEP_BATCH = 1000

export interface AskSweepDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  transactions: TransactionRunner
  clock: Clock
}

// The `asks_closed` index serves the inner select (09 §4.5).
const SWEEP = `DELETE FROM asks WHERE id IN (
  SELECT id FROM asks WHERE closed_at < ? ORDER BY closed_at LIMIT ?)`

/** Deletes every ask closed more than 7 days ago; returns how many were deleted. */
export function sweepClosedAsks({ db, transactions, clock }: AskSweepDeps): number {
  const before = clock.now() - CLOSED_ASK_RETENTION_MS
  let total = 0
  for (;;) {
    const deleted = transactions.inTransaction(
      () => db.run(SWEEP, [before, ASK_SWEEP_BATCH]).changes
    )
    total += deleted
    if (deleted < ASK_SWEEP_BATCH) return total
  }
}
