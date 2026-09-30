// The Host database's migration runner (09 §6.2; ADR-005 items 1, 2, 4–6): the one way the Host
// opens `dwarfai.db`, and it only moves forward. Versions live in `schema_migrations`, never in
// the SQLite header's version pragma (the retired #575 floor, ADR-005 item 2).
//
// `openHostDb` follows the steps of 09 §6.2 in order:
//   1. identity: a file that is not a DwarfAI Host database (the legacy projects-v1.db included)
//      is refused `NOT_A_DWARFAI_DB` without being written — it is probed read-only before the
//      writer, whose WAL pragma would rewrite its header (NFR-PERS-15, FM-102);
//   2. history: every applied version the build knows must carry the build's name and checksum,
//      and the history must be 1…k with no gap, else `SCHEMA_TAMPERED` (FM-101);
//   3. the future: a highest applied version above the build's opens `query_only` with the
//      capability `db-read-only`, and nothing is written (ADR-005 item 5, FM-100);
//   4. pending: the known versions above the highest applied; none → done;
//   5. backup: a non-empty database is copied `VACUUM INTO` first (`../backup.ts`, FM-099); when
//      no complete backup could be written nothing is migrated, `BACKUP_FAILED` (FM-105);
//   6. dev guard: a dev or test build whose database lies in the release data directory refuses
//      to migrate it, `DEV_BUILD_ON_RELEASE_DATA` (ADR-005 item 6, FM-107). It is checked before
//      step 5 writes anything: a backup there would be a write into the release data directory,
//      and its rotation would delete the oldest of the person's own backups. The refused open
//      leaves that directory byte-identical, which is the guard's purpose ("no dev build can
//      corrupt a user's DB", ADR-005; FM-107 "data-directory check before migrating"). Every
//      outcome of 09 §6.2 is unchanged; only a refused dev build writes less;
//   7. `foreign_keys = OFF` outside any transaction, one `BEGIN IMMEDIATE` for every pending
//      migration and its `schema_migrations` row, `PRAGMA foreign_key_check` before `COMMIT`,
//      then `foreign_keys = ON`, verified. A failure rolls everything back: the file stays at its
//      previous version with its data intact (FM-099).
//
// Refusals are values (the boot turns them into FM-008). A migration that throws, or a
// foreign_key_check row, propagates as an error after the rollback; the connection is closed.
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { HostInvariantError, SqliteInfrastructureError } from '../../../kernel/domain/errors'
import type { Result } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { SqliteDatabase, SqliteRow } from '../../../kernel/ports/sqliteDatabase'
import { VacuumIntoBackup } from '../backup'
import { NodeSqliteDatabase, toInfrastructureError } from '../NodeSqliteDatabase'
import { isUnreadableDatabaseError, quarantineUnreadableDb } from '../quarantine'
import { SqliteTransactionRunner } from '../SqliteTransactionRunner'
import { knownMigrations } from './index'
import { migrationChecksum, type BackupStep, type Migration } from './types'

export type BuildKind = 'release' | 'dev' | 'test'

export type HostDbRefusal =
  | 'NOT_A_DWARFAI_DB'
  | 'SCHEMA_TAMPERED'
  | 'DEV_BUILD_ON_RELEASE_DATA'
  | 'BACKUP_FAILED'
  | 'QUARANTINE_FAILED'

export interface OpenHostDbOptions {
  buildKind: BuildKind
  /** The release build's data directory; a dev or test build never migrates a database in it. */
  releaseDataDir: string
  /** Written to `schema_migrations.app_version` for each migration applied. */
  appVersion: string
  /** The source of `schema_migrations.applied_at` and of the backup and quarantine stamps. */
  clock: Clock
  /** Where the `db.*` records of 19 §9.5 go. */
  log: DiagnosticsLog
  /** The build's migrations; the registered list (`./index`) by default. */
  migrations?: readonly Migration[]
  /**
   * Opens the writer; `NodeSqliteDatabase` logging to `log` by default. The fault-injecting
   * writer of `../testing/FaultySqlite.ts` in tests (17 §1.10).
   */
  openWriter?: (path: string) => SqliteDatabase
  /** Step 5; the `VACUUM INTO` backup (`../backup.ts`) over `clock` and `log` by default. */
  backup?: BackupStep
}

export type OpenedHostDb =
  | { readOnly: false; db: SqliteDatabase; version: number; applied: readonly number[] }
  | { readOnly: true; capability: 'db-read-only'; db: SqliteDatabase; version: number }

type OpenResult = Result<OpenedHostDb, HostDbRefusal>

/** 09 §6.1 (D-07): the identity marker migration 1 writes; never a version. */
const DWARFAI_APPLICATION_ID = 0x44574149

type Queryable = Pick<SqliteDatabase, 'all'>

function scalar(db: Queryable, sql: string): unknown {
  const [row] = db.all(sql)
  return row === undefined ? undefined : Object.values(row)[0]
}

function isNonEmpty(db: Queryable): boolean {
  return scalar(db, 'SELECT count(*) FROM sqlite_schema') !== 0
}

/** SQLite reported the file unreadable (`SQLITE_CORRUPT` / `SQLITE_NOTADB`) while opening it. */
class UnreadableDatabase extends Error {
  constructor(override readonly cause: SqliteInfrastructureError) {
    super(cause.message, { cause })
    this.name = 'UnreadableDatabase'
  }
}

/**
 * Run a read of the opening sequence (the probe, the writer's open, steps 1–2). An unreadable
 * database there leads to the quarantine; the same error anywhere later is the current command's
 * infrastructure failure (16 §2.1), never a reason to rename the file.
 */
function readable<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (isUnreadableDatabaseError(error)) throw new UnreadableDatabase(error)
    throw error
  }
}

/** The build's list must be versions 1…n in order, each checksum computed from its own SQL. */
function assertLinear(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new HostInvariantError(
        `migration ${migration.name} has version ${migration.version} at position ${index + 1}; versions are 1…n with no gap or reorder (ADR-005 item 4)`
      )
    }
    if (migration.checksum !== migrationChecksum(migration.sql)) {
      throw new HostInvariantError(
        `migration ${migration.name} declares a checksum that is not the SHA-256 of its SQL text (ADR-005 item 4)`
      )
    }
  })
}

// Step 1 -------------------------------------------------------------------------------------

/**
 * A file is the Host's when it carries DwarfAI's application_id, or when it is new: id 0 and no
 * schema object yet. Anything else is foreign, the legacy projects-v1.db (id 0, tables) included.
 */
function isForeign(db: Queryable): boolean {
  const applicationId = scalar(db, 'PRAGMA application_id')
  if (applicationId === DWARFAI_APPLICATION_ID) return false
  return applicationId !== 0 || isNonEmpty(db)
}

/** The first 16 bytes of every SQLite database file (sqlite.org/fileformat.html §1.3). */
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1')

/**
 * A non-empty file that does not start with the SQLite header is not a database. Checked before
 * any SQLite connection: with a `-wal` beside the file SQLite opens the WAL before it reads the
 * header, and would rewrite the `-shm` of a file about to be quarantined (09 §8.3).
 */
function assertSqliteHeader(path: string): void {
  const header = Buffer.alloc(SQLITE_HEADER.length)
  const fd = openSync(path, 'r')
  let read: number
  try {
    read = readSync(fd, header, 0, header.length, 0)
  } finally {
    closeSync(fd)
  }
  if (read < header.length || !header.equals(SQLITE_HEADER)) {
    throw new SqliteInfrastructureError('SQLITE_NOTADB', 26, 'file is not a database')
  }
}

/**
 * Step 1 before the writer opens. With no `-wal` beside it the main file is complete and is read
 * `immutable` (no lock, no side file); with one, a plain read-only connection also reads the WAL.
 * Neither writes the main file. The probe also reads the step-2 history, so a file that cannot be
 * read (SQLITE_CORRUPT, SQLITE_NOTADB) is found before the writer opens, and the writer never
 * checkpoints into a file about to be quarantined.
 */
function probeIsForeign(path: string): boolean {
  let size: number
  try {
    size = statSync(path).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (size === 0) return false
  assertSqliteHeader(path)
  const location = existsSync(`${path}-wal`) ? path : `${pathToFileURL(path).href}?immutable=1`
  let probe: DatabaseSync
  try {
    probe = new DatabaseSync(location, { readOnly: true })
  } catch (error) {
    throw toInfrastructureError(error)
  }
  try {
    const reader: Queryable = { all: (sql) => probe.prepare(sql).all() as SqliteRow[] }
    if (isForeign(reader)) return true
    readApplied(reader)
    return false
  } catch (error) {
    throw toInfrastructureError(error)
  } finally {
    probe.close()
  }
}

// Step 2 -------------------------------------------------------------------------------------

interface AppliedMigration {
  version: number
  name: string
  checksum: string
}

/** The applied history in version order; empty on a new file, which has no table yet. */
function readApplied(db: Queryable): AppliedMigration[] {
  const hasTable =
    scalar(
      db,
      "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'"
    ) !== 0
  if (!hasTable) return []
  return db
    .all('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .map((row) => ({
      version: Number(row['version']),
      name: String(row['name']),
      checksum: String(row['checksum'])
    }))
}

/**
 * The history must be exactly versions 1…k, and every applied version the build knows must
 * carry the build's name and checksum. Versions above the build's highest are the future
 * (step 3): the build cannot check them.
 */
function isTampered(applied: readonly AppliedMigration[], known: readonly Migration[]): boolean {
  return applied.some((row, index) => {
    if (row.version !== index + 1) return true
    const migration = known[index]
    return (
      migration !== undefined &&
      (migration.checksum !== row.checksum || migration.name !== row.name)
    )
  })
}

// Step 6 -------------------------------------------------------------------------------------

function canonicalDir(dir: string): string {
  const resolved = resolve(dir)
  let real: string
  try {
    real = realpathSync.native(resolved)
  } catch {
    real = resolved
  }
  // Windows and macOS file systems compare names case-insensitively by default.
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real
}

/** A dev or test build whose database lies in (or under) the release data directory. */
function isDevBuildOnReleaseData(path: string, options: OpenHostDbOptions): boolean {
  if (options.buildKind === 'release') return false
  const inside = relative(canonicalDir(options.releaseDataDir), canonicalDir(dirname(path)))
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
}

// Step 7 -------------------------------------------------------------------------------------

function applyPending(
  db: SqliteDatabase,
  pending: readonly Migration[],
  options: OpenHostDbOptions
): void {
  // Outside any transaction: SQLite ignores this pragma inside one (09 §6.3).
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    new SqliteTransactionRunner(db).inTransaction(() => {
      for (const migration of pending) {
        migration.up(db)
        db.run(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at, app_version) VALUES (?, ?, ?, ?, ?)',
          [
            migration.version,
            migration.name,
            migration.checksum,
            options.clock.now(),
            options.appVersion
          ]
        )
      }
      const violations = db.all('PRAGMA foreign_key_check')
      if (violations.length > 0) {
        throw new HostInvariantError(
          `PRAGMA foreign_key_check reported ${violations.length} row(s) after migrating; nothing was committed`
        )
      }
    })
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
  if (scalar(db, 'PRAGMA foreign_keys') !== 1) {
    throw new HostInvariantError('PRAGMA foreign_keys does not read 1 after migrating')
  }
}

// --------------------------------------------------------------------------------------------

/** Steps 1 (again, on the writer) to 7 over the open writer. */
function runSteps(
  db: SqliteDatabase,
  path: string,
  migrations: readonly Migration[],
  options: OpenHostDbOptions
): OpenResult {
  // The file may have appeared or changed since the probe.
  if (readable(() => isForeign(db))) return { ok: false, error: 'NOT_A_DWARFAI_DB' }

  const applied = readable(() => readApplied(db))
  if (isTampered(applied, migrations)) return { ok: false, error: 'SCHEMA_TAMPERED' }

  const from = applied.at(-1)?.version ?? 0
  const highestKnown = migrations.at(-1)?.version ?? 0
  if (from > highestKnown) {
    db.exec('PRAGMA query_only = ON')
    if (scalar(db, 'PRAGMA query_only') !== 1) {
      throw new HostInvariantError('PRAGMA query_only does not read 1 on a newer database')
    }
    return { ok: true, value: { readOnly: true, capability: 'db-read-only', db, version: from } }
  }

  const pending = migrations.slice(from)
  if (pending.length > 0) {
    // Step 6 is decided before step 5 writes anything (see the header).
    if (isDevBuildOnReleaseData(path, options)) {
      return { ok: false, error: 'DEV_BUILD_ON_RELEASE_DATA' }
    }
    if (isNonEmpty(db)) {
      const backup = options.backup ?? new VacuumIntoBackup(options)
      const written = backup.beforeMigrating({ db, path, fromVersion: from })
      if (!written.ok) return written
    }
    applyPending(db, pending, options)
  }
  return {
    ok: true,
    value: { readOnly: false, db, version: highestKnown, applied: pending.map((m) => m.version) }
  }
}

/** Steps 1–7 on the file at `path` as it is now. */
function openFile(
  path: string,
  migrations: readonly Migration[],
  options: OpenHostDbOptions
): OpenResult {
  if (readable(() => probeIsForeign(path))) return { ok: false, error: 'NOT_A_DWARFAI_DB' }
  // A database not created yet has every known migration pending (steps 1–5 pass or do nothing
  // on a new file), so the step-6 refusal is decided before the writer would create the file.
  if (migrations.length > 0 && !existsSync(path) && isDevBuildOnReleaseData(path, options)) {
    return { ok: false, error: 'DEV_BUILD_ON_RELEASE_DATA' }
  }
  const db = readable(
    () => options.openWriter?.(path) ?? NodeSqliteDatabase.open(path, { log: options.log })
  )
  let result: OpenResult
  try {
    result = runSteps(db, path, migrations, options)
  } catch (error) {
    db.close()
    throw error
  }
  if (!result.ok) db.close()
  return result
}

/**
 * Open the Host database at `path`, migrating it forward when the build knows newer versions.
 * A file SQLite cannot read as a database is quarantined and a fresh one created (09 §8.3).
 * On success the caller owns `db`; on a refusal or an error the connection is already closed.
 */
export function openHostDb(path: string, options: OpenHostDbOptions): OpenResult {
  const migrations = options.migrations ?? knownMigrations
  assertLinear(migrations)
  try {
    return openFile(path, migrations, options)
  } catch (error) {
    if (!(error instanceof UnreadableDatabase)) throw error
    // The quarantine renames files in the database's directory: never a dev build's write in the
    // release data directory (ADR-005 item 6).
    if (isDevBuildOnReleaseData(path, options)) {
      return { ok: false, error: 'DEV_BUILD_ON_RELEASE_DATA' }
    }
    const moved = quarantineUnreadableDb(path, error.cause, options)
    if (!moved.ok) return moved
  }
  try {
    return openFile(path, migrations, options)
  } catch (error) {
    throw error instanceof UnreadableDatabase ? error.cause : error
  }
}
