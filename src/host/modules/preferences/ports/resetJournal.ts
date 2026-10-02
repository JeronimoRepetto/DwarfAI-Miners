// Driven ports of the Reset-metrics saga (05 §3.12, 16 §4.12; ADR-023 item 4). `ResetJournal` is
// the `reset_journal` row of one saga (09 §4.1): its writer is `SqliteResetJournal`. `ResetDbStep`
// is one module's table set of the saga's `db` step: every registered step joins the one
// `db` transaction (16 §2.2 "nested calls join"), so a step's `reset(tx)` is synchronous and does
// no I/O outside the database.
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { ResetStep } from '../domain/resetSaga'

// As 16 §4.12 writes them (names, members and comments; layout by prettier)
export interface ResetJournal {
  // ADR-023 D4: one row per saga, idempotent steps
  begin(tx: TransactionRunner): { id: string; epoch: number }
  step(id: string): ResetStep
  advance(id: string, s: ResetStep): void
}
export interface ResetDbStep {
  readonly name: string
  reset(tx: TransactionRunner): void
} // the saga's 'db' step, one per module table set (mines, crew, ledger, conversation, launching, preferences; launching runs after the mines and crew steps, 09 §7.2 step 4) (AMENDMENT-10, OQ-78)
