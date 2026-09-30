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
//   5. backup: a non-empty database goes through the `BackupStep` first (later: ISSUE-040);
//   6. dev guard: a dev or test build whose database lies in the release data directory refuses
//      to migrate it, `DEV_BUILD_ON_RELEASE_DATA` (ADR-005 item 6, FM-107);
//   7. `foreign_keys = OFF` outside any transaction, one `BEGIN IMMEDIATE` for every pending
//      migration and its `schema_migrations` row, `PRAGMA foreign_key_check` before `COMMIT`,
//      then `foreign_keys = ON`, verified. A failure rolls everything back: the file stays at its
//      previous version with its data intact (FM-099).
//
// Refusals are values (the boot turns them into FM-008). A migration that throws, or a
// foreign_key_check row, propagates as an error after the rollback; the connection is closed.
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { Result } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { SqliteDatabase, SqliteRow } from '../../../kernel/ports/sqliteDatabase'
import { NodeSqliteDatabase, toInfrastructureError } from '../NodeSqliteDatabase'
import { SqliteTransactionRunner } from '../SqliteTransactionRunner'
import { knownMigrations } from './index'
import { migrationChecksum, noBackup, type BackupStep, type Migration } from './types'

export type BuildKind = 'release' | 'dev' | 'test'

export type HostDbRefusal = 'NOT_A_DWARFAI_DB' | 'SCHEMA_TAMPERED' | 'DEV_BUILD_ON_RELEASE_DATA'

export interface OpenHostDbOptions {
  buildKind: BuildKind
  /** The release build's data directory; a dev or test build never migrates a database in it. */
  releaseDataDir: string
  /** Written to `schema_migrations.app_version` for each migration applied. */
  appVersion: string
  /** The source of `schema_migrations.applied_at`. */
  clock: Clock
  /** The build's migrations; the registered list (`./index`) by default. */
  migrations?: readonly Migration[]
  /** Step 5; writes nothing by default (later: ISSUE-040). */
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

/**
 * Step 1 before the writer opens. With no `-wal` beside it the main file is complete and is read
 * `immutable` (no lock, no side file); with one, a plain read-only connection also reads the WAL.
 * Neither writes the main file.
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
  const location = existsSync(`${path}-wal`) ? path : `${pathToFileURL(path).href}?immutable=1`
  let probe: DatabaseSync
  try {
    probe = new DatabaseSync(location, { readOnly: true })
  } catch (error) {
    throw toInfrastructureError(error)
  }
  try {
    return isForeign({ all: (sql) => probe.prepare(sql).all() as SqliteRow[] })
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
  if (isForeign(db)) return { ok: false, error: 'NOT_A_DWARFAI_DB' }

  const applied = readApplied(db)
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
    if (isNonEmpty(db))
      (options.backup ?? noBackup).beforeMigrating({ db, path, fromVersion: from })
    if (isDevBuildOnReleaseData(path, options)) {
      return { ok: false, error: 'DEV_BUILD_ON_RELEASE_DATA' }
    }
    applyPending(db, pending, options)
  }
  return {
    ok: true,
    value: { readOnly: false, db, version: highestKnown, applied: pending.map((m) => m.version) }
  }
}

/**
 * Open the Host database at `path`, migrating it forward when the build knows newer versions.
 * On success the caller owns `db`; on a refusal or an error the connection is already closed.
 */
export function openHostDb(path: string, options: OpenHostDbOptions): OpenResult {
  const migrations = options.migrations ?? knownMigrations
  assertLinear(migrations)
  if (probeIsForeign(path)) return { ok: false, error: 'NOT_A_DWARFAI_DB' }
  // A database not created yet has every known migration pending (steps 1–5 pass or do nothing
  // on a new file), so the step-6 refusal is decided before the writer would create the file.
  if (migrations.length > 0 && !existsSync(path) && isDevBuildOnReleaseData(path, options)) {
    return { ok: false, error: 'DEV_BUILD_ON_RELEASE_DATA' }
  }
  const db = NodeSqliteDatabase.open(path)
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
