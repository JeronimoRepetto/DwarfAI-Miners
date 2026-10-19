// The attention maintenance sweep (09 §7.1 row `attention_keys`; ADR-018 D2–D4): a withdrawn key,
// emitted or suppressed, is deleted 24 hours after its `withdrawn_at`; a key not withdrawn yet (its
// fact is still open) is never swept. "Older than 24 hours" is strict: a key withdrawn exactly
// 24 hours ago waits for the next sweep. Time comes from the kernel `Clock`, read once per sweep.
// Each statement deletes at most `SWEEP_BATCH` rows in its own transaction, so the single writer
// is never held long (09 §8.1); the sweep repeats until a statement deletes fewer. When it runs is
// the composition's choice (later: ISSUE-119).
import type { Clock } from '../../../kernel/ports/clock'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { AttentionLedger } from '../ports/attentionLedger'

/** 09 §7.1: withdrawn keys are kept 24 hours. */
export const WITHDRAWN_KEY_RETENTION_MS = 24 * 60 * 60 * 1000

/** Rows deleted per statement (ISSUE-110: bounded to 1 000 rows per statement). */
export const SWEEP_BATCH = 1000

export interface AttentionSweepDeps {
  ledger: AttentionLedger
  transactions: TransactionRunner
  clock: Clock
}

/** Deletes every withdrawn key older than 24 hours; returns how many were deleted. */
export function sweepWithdrawnKeys({ ledger, transactions, clock }: AttentionSweepDeps): number {
  const before = clock.now() - WITHDRAWN_KEY_RETENTION_MS
  let total = 0
  for (;;) {
    const deleted = transactions.inTransaction(() => ledger.sweepWithdrawn(before, SWEEP_BATCH))
    total += deleted
    if (deleted < SWEEP_BATCH) return total
  }
}
