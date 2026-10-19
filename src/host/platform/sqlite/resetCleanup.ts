// The post-commit part of the Reset saga's `db` step (ADR-023 items 1, 4.2; 09 §7.2, D-11; 07
// S13.01, S13.08), on the Host's database file. The saga runs it after the `db` commit and before
// it advances the journal past `db`, and again on every resume from `db`, so each action is
// idempotent:
// - `deleteBackups`: every `<db file>.bak-*` beside the database (the pre-migration backups of
//   backup.ts, an interrupted `.partial` copy included) — they are copies of the wiped
//   conversation and ledger. A file already gone is not an error.
// - `truncateWal`: `PRAGMA wal_checkpoint(TRUNCATE)`, so no deleted text lingers in the WAL.
// - `vacuum`: `VACUUM` (never inside a transaction), so no deleted text lingers in free pages.
import { readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'

export interface SqliteResetCleanupDeps {
  /** The Host's writer. */
  db: SqliteDatabase
  /** The database file the writer opened. */
  path: string
}

export class SqliteResetCleanup {
  constructor(private readonly deps: SqliteResetCleanupDeps) {}

  deleteBackups(): void {
    const dir = dirname(this.deps.path)
    const prefix = `${basename(this.deps.path)}.bak-`
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix)) rmSync(join(dir, name), { force: true })
    }
  }

  truncateWal(): void {
    this.deps.db.all('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  vacuum(): void {
    this.deps.db.exec('VACUUM')
  }
}
