// The preferences module's `ResetDbStep` (16 §4.12; 09 §7.2 row `host_preferences`: "default (all
// columns)"; ADR-023 item 1). It joins the saga's one `db` transaction (16 §2.2).
//
// The singleton row is replaced by migration 1's seed row (09 §4.9: only `id` and `updated_at`
// given), so the column DEFAULTs stay the one source of the defaults. `integration_settings` and
// `channel_tokens` are not touched here: each integration returns to off when its revert completes
// in step `external-config` (09 D-22; 07 S14.06), so `openCodePermissionsOn`, derived from it,
// keeps telling the truth until then.
import type { Clock } from '../../../../kernel/ports/clock'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import type { ResetDbStep } from '../../ports/resetJournal'

export interface PreferencesResetStepDeps {
  db: SqliteDatabase
  clock: Clock
}

export class PreferencesResetStep implements ResetDbStep {
  readonly name = 'preferences'

  constructor(private readonly deps: PreferencesResetStepDeps) {}

  reset(tx: TransactionRunner): void {
    tx.inTransaction(() => {
      this.deps.db.run('DELETE FROM host_preferences WHERE id = 1')
      this.deps.db.run('INSERT INTO host_preferences (id, updated_at) VALUES (1, ?)', [
        this.deps.clock.now()
      ])
    })
  }
}
