// `SqliteResetJournal` (16 §4.12 row `ResetJournal`; 05 §3.12): one `reset_journal` row per saga
// (09 §4.1), whose `step` is the last completed step (07 §13).
//
// - `begin(tx)` runs inside the caller's transaction (it joins it, 16 §2.2): it adds 1 to
//   `app_meta.reset_epoch`, clears `app_meta.welcome_answered_at` (the first-run step is due again,
//   07 S41.07; AMENDMENT-7) and writes the row directly at `db`, so `begun` and `db` are one
//   transaction with every `ResetDbStep` (07 S13.01; 09 §7.2 step (1)). The port gap for the
//   `welcome_answered_at` column (`WelcomeAnswerStore`) is recorded later (ISSUE-222).
//   `reset_journal_one_active` refuses a second unfinished saga, which aborts the transaction.
// - `advance(id, s)` only moves forward in the 07 §13 order: the same or an earlier step is a no-op,
//   so a resumed saga that repeats a step leaves the row as it was. `done` writes `finished_at`.
// - `unfinished()` and `fail(id, reason)` (amendment, owner-approved 2026-10-02, ISSUE-212): the
//   one row not `done`, for the boot resume (07 S13.08); and `last_failure`, the fixed reason of
//   the last failed step, never content (07 S13.07; 10 `reset_journal.last_failure`).
import type { Clock } from '../../../../kernel/ports/clock'
import type { IdGenerator } from '../../../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import { RESET_STEPS, type ResetStep } from '../../domain/resetSaga'
import type { ResetJournal } from '../../ports/resetJournal'

export interface SqliteResetJournalDeps {
  db: SqliteDatabase
  clock: Clock
  ids: IdGenerator
}

const BUMP_EPOCH = `
  UPDATE app_meta SET reset_epoch = reset_epoch + 1, welcome_answered_at = NULL WHERE id = 1
  RETURNING reset_epoch`

const INSERT = `
  INSERT INTO reset_journal (id, epoch, step, started_at, step_at) VALUES (?, ?, 'db', ?, ?)`

const ADVANCE = `
  UPDATE reset_journal SET step = ?, step_at = ?, finished_at = ? WHERE id = ?`

export class SqliteResetJournal implements ResetJournal {
  constructor(private readonly deps: SqliteResetJournalDeps) {}

  begin(tx: TransactionRunner): { id: string; epoch: number } {
    return tx.inTransaction(() => {
      const [row] = this.deps.db.all(BUMP_EPOCH)
      // Migration 1 seeds app_meta row 1 in the transaction that creates the table (09 §4.9).
      if (row === undefined) throw new Error('the app_meta row is missing')
      const epoch = Number(row['reset_epoch'])
      const id = this.deps.ids.uuidv7()
      const now = this.deps.clock.now()
      this.deps.db.run(INSERT, [id, epoch, now, now])
      return { id, epoch }
    })
  }

  step(id: string): ResetStep {
    const [row] = this.deps.db.all('SELECT step FROM reset_journal WHERE id = ?', [id])
    if (row === undefined) throw new Error('no reset_journal row with this id')
    return row['step'] as ResetStep
  }

  advance(id: string, s: ResetStep): void {
    if (RESET_STEPS.indexOf(s) <= RESET_STEPS.indexOf(this.step(id))) return
    const now = this.deps.clock.now()
    this.deps.db.run(ADVANCE, [s, now, s === 'done' ? now : null, id])
  }

  unfinished(): { id: string; epoch: number; step: ResetStep } | null {
    // `reset_journal_one_active` keeps at most one such row (09 §4.1).
    const [row] = this.deps.db.all("SELECT id, epoch, step FROM reset_journal WHERE step <> 'done'")
    if (row === undefined) return null
    return { id: String(row['id']), epoch: Number(row['epoch']), step: row['step'] as ResetStep }
  }

  fail(id: string, reason: string): void {
    const { changes } = this.deps.db.run('UPDATE reset_journal SET last_failure = ? WHERE id = ?', [
      reason,
      id
    ])
    if (changes === 0) throw new Error('no reset_journal row with this id')
  }
}
