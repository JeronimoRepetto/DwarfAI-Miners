// A linear migration of the Host database (ADR-005 item 4; 09 §6.2).
//
// - `version` is 1, 2, 3 … strictly increasing and never reused; `name` is kebab-case
//   (`0001-initial`).
// - `sql` is the migration's SQL text (seed statements with their named parameters included), and
//   `checksum` is the SHA-256 of that text after line-end normalisation to LF, so it is stable
//   across builds, OSes and a CRLF checkout. The runner verifies it for every applied version at
//   every open (`SCHEMA_TAMPERED`), which is what keeps an applied migration from being rewritten
//   (21 §5.1).
// - `up` runs synchronously inside the one migration transaction; by default it executes `sql`.
//   A migration that binds seed parameters supplies its own `up` over the same `sql`.
import { createHash } from 'node:crypto'
import type { Result } from '../../../kernel/domain/values'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'

export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
  readonly checksum: string
  up(db: SqliteDatabase): void
}

/** SHA-256 (hex) of a migration's SQL text, CRLF and CR normalised to LF first. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n?/g, '\n'), 'utf8').digest('hex')
}

export interface MigrationSource {
  version: number
  name: string
  sql: string
  up?: (db: SqliteDatabase) => void
}

/** Build a migration whose checksum is computed from its SQL text. */
export function defineMigration(source: MigrationSource): Migration {
  const { version, name, sql } = source
  const up = source.up ?? ((db: SqliteDatabase) => db.exec(sql))
  return { version, name, sql, checksum: migrationChecksum(sql), up }
}

/**
 * Step 5 of 09 §6.2: before pending migrations are applied to a non-empty database, a backup is
 * written (`VACUUM INTO`, `../backup.ts`). `BACKUP_FAILED` means no complete backup exists, and
 * the runner then migrates nothing (13 FM-105).
 */
export interface BackupStep {
  beforeMigrating(input: {
    db: SqliteDatabase
    path: string
    fromVersion: number
  }): Result<void, 'BACKUP_FAILED'>
}
