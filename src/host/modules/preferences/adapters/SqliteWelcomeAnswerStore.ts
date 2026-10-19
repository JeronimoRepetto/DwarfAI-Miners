// `SqliteWelcomeAnswerStore` (16 §4.12 row `WelcomeAnswerStore`; AMENDMENT-10, OQ-78): the one
// reader and writer of `app_meta.welcome_answered_at` (09 D-25), the persisted part of the
// first-run consent step (07 machine 41). Both statements run inside the caller's transaction
// (16 §2.2). The column's CHECK refuses a negative instant; the Reset `db` step clears it with the
// epoch bump (SqliteResetJournal), which makes the step due again (S41.07).
import type { Instant } from '../../../kernel/domain/values'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { WelcomeAnswerStore } from '../ports/welcomeAnswerStore'

export interface SqliteWelcomeAnswerStoreDeps {
  db: SqliteDatabase
}

const READ = 'SELECT welcome_answered_at FROM app_meta WHERE id = 1'
const WRITE = 'UPDATE app_meta SET welcome_answered_at = ? WHERE id = 1'

export class SqliteWelcomeAnswerStore implements WelcomeAnswerStore {
  constructor(private readonly deps: SqliteWelcomeAnswerStoreDeps) {}

  answeredAt(): Instant | null {
    const at = this.deps.db.all(READ)[0]?.['welcome_answered_at']
    return typeof at === 'number' || typeof at === 'bigint' ? Number(at) : null
  }

  setAnsweredAt(t: Instant): void {
    this.deps.db.run(WRITE, [t])
  }
}
