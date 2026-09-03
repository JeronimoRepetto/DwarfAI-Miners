import {
  NodeWritableSqlite,
  type WritableSqliteDb,
  type WritableSqliteLike
} from '../adapters/sqliteWritable'

/**
 * The one database this app writes: its file, its schema version, and the
 * migrations between versions (#93).
 *
 * It has two tenants — the projects list (src/main/projects/) and the material
 * vault (src/main/ledger/) — and it is a subject of its own precisely because
 * neither owns it. Before this module the schema lived inside the projects
 * store, which was honest while projects were the only rows in the file; a
 * second tenant made it the wrong home for the version stamp both depend on.
 *
 * ONE HANDLE, SHARED. connect() opens once and hands the same handle to every
 * caller. Two DatabaseSync handles on one file do not share a write queue: in
 * WAL mode the second writer gets SQLITE_BUSY, so a ledger save landing inside
 * a projects write would surface as a spurious 'locked' failure roughly as
 * often as the two 30-second throttles happen to line up. One handle removes
 * the question rather than tuning a busy timeout around it.
 *
 * node:sqlite is synchronous, so every statement runs on the main thread. That
 * is what both tenants' throttles exist to bound (materialLedger.ts:34,
 * projectObserver.ts:22), and it is why this module's API is async though the
 * driver is not.
 */

/**
 * The file name, unchanged from slice 1 and deliberately not renamed.
 *
 * The database gained tables; it did not become a different database. A
 * `app-v2.db` here would leave every project the user has already declared in
 * a file nothing opens — the exact orphaning the versioned-filename convention
 * exists to make deliberate, and there is nothing deliberate about it here.
 * The version lives in PRAGMA user_version, which is what a migration can act
 * on and a filename cannot.
 */
export const APP_DB_FILENAME = 'projects-v1.db'

/** Stamped in PRAGMA user_version. Older versions walk up to it; above is refused. */
export const APP_SCHEMA_VERSION = 3

/**
 * The version the ledger's tables arrived in.
 *
 * Read by openLedgerStore to answer one question it cannot otherwise answer: a
 * database stamped below this has never held the vault, so the JSON file is
 * still the current copy. It equals APP_SCHEMA_VERSION today and must NOT be
 * bumped along with it — a later schema change does not move when the ledger
 * moved in.
 */
export const LEDGER_TABLES_SINCE = 2

/** Refusal to touch a database this build did not write and cannot upgrade. */
export class UnsupportedSchemaError extends Error {}

/**
 * The projects list — slice 1's table, plus the column v3 added.
 *
 * added_at and last_opened_at are separate columns because #92 sorts by either,
 * and they answer different questions: one is provenance, the other recency.
 * name_norm is written by both INSERT paths (see projects/projectName.ts) so a
 * search never has to fold a column it is scanning. The three indexes are the
 * three orders #92 asked for; none of them is speculative — and map_site
 * deliberately has none, since the only question asked of it is "which sites
 * are taken", one scan of a table with one row per project the user has ever
 * opened.
 */
const CREATE_PROJECTS = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  origin TEXT NOT NULL,
  last_provider TEXT,
  known_tier TEXT,
  map_site INTEGER
);
CREATE INDEX projects_name_norm ON projects (name_norm);
CREATE INDEX projects_added_at ON projects (added_at);
CREATE INDEX projects_last_opened_at ON projects (last_opened_at);
`

/**
 * Schema v2 — the material vault, moved out of material-ledger-v1.json.
 *
 * `materials` is one row per mine per material, keyed on the pair. That shape
 * is the "materials never convert into one another" invariant made structural:
 * there is no column a total could be summed into, and no way to write a mine's
 * gold without naming gold. Rows are only ever written for a material a mine
 * has actually produced.
 *
 * `session_marks` is the anti-double-counting table (domain/ledger.ts:33-41) —
 * the last counter value seen for one session, and when. It is bookkeeping, not
 * history: pruning drops a mark, never a material row.
 *
 * `ledger_meta` records that the JSON document has been read for the last time.
 * Its presence, and nothing else, is what makes the JSON file ignorable — see
 * ledger/ledgerMigration.ts for why that has to be a stored fact rather than an
 * inference from whether any rows exist.
 */
const CREATE_LEDGER = `
CREATE TABLE materials (
  mine_id TEXT NOT NULL,
  material TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  PRIMARY KEY (mine_id, material)
);
CREATE TABLE session_marks (
  key TEXT PRIMARY KEY NOT NULL,
  tokens INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE TABLE ledger_meta (
  key TEXT PRIMARY KEY NOT NULL,
  migrated_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  mines INTEGER NOT NULL,
  sessions INTEGER NOT NULL
);
`

/**
 * Schema v3 — where each project's mine stands on the world map (#136).
 *
 * One nullable integer, holding the id of one of the design's 74 spawn
 * locations. Nullable because there are three honest ways to have no site: a
 * project that predates this column, a project the store has not placed yet,
 * and a valley with all 74 locations already taken. A zero or a -1 would make
 * all three indistinguishable from location zero.
 *
 * No UNIQUE constraint, though two mines must never share a location. The
 * uniqueness the design asks for is over LIVE projects and is enforced where
 * the choice is made — a UNIQUE index would additionally make the 75th project
 * a write FAILURE rather than a project drawn at a shared site, which is a
 * database error raised over a cosmetic problem.
 */
const ADD_MAP_SITE = `ALTER TABLE projects ADD COLUMN map_site INTEGER`

/**
 * One step up from `from` to `from + 1`, applied in order and each in its own
 * transaction — which is what lets a database that has fallen two versions
 * behind catch up in one open without a crash ever leaving a stamp that does
 * not describe the file.
 */
const UPGRADES: readonly { from: number; apply: (db: WritableSqliteDb) => void }[] = [
  { from: 1, apply: (db) => db.exec(CREATE_LEDGER) },
  { from: 2, apply: (db) => db.exec(ADD_MAP_SITE) }
]

export interface AppDatabase {
  /**
   * The one open handle, connecting and preparing the schema on the first call.
   * Rejects with SqliteWriteError or UnsupportedSchemaError — never with a null
   * handle, so no caller can mistake "could not open" for "opened and empty".
   */
  connect(): Promise<WritableSqliteDb>
  /**
   * The stamped schema version, read on a throwaway handle without preparing
   * anything, or null when the database cannot be asked at all.
   *
   * Never throws: this is the question a caller asks BECAUSE connect() failed,
   * and it must not fail the same way.
   */
  schemaVersion(): Promise<number | null>
  /** Drop the handle after a failed statement, so the next connect() reopens. */
  invalidate(): void
  close(): void
}

export interface AppDatabaseOptions {
  /** Full path of the database file (under userData in production). */
  filePath: string
  /** Injected for tests; defaults to the real node:sqlite driver. */
  sqlite?: WritableSqliteLike
}

export function createAppDatabase(options: AppDatabaseOptions): AppDatabase {
  const sqlite = options.sqlite ?? new NodeWritableSqlite()
  let handle: WritableSqliteDb | null = null
  /** In-flight open, so two tenants asking at once still get one file handle. */
  let opening: Promise<WritableSqliteDb> | null = null

  async function open(): Promise<WritableSqliteDb> {
    const db = await sqlite.open(options.filePath)
    try {
      prepareAppSchema(db)
    } catch (error) {
      db.close()
      throw error
    }
    handle = db
    return db
  }

  function release(): void {
    const open = handle
    handle = null
    open?.close()
  }

  return {
    async connect() {
      if (handle !== null) return handle
      opening ??= open().finally(() => {
        opening = null
      })
      return opening
    },

    async schemaVersion() {
      try {
        const db = await sqlite.open(options.filePath)
        try {
          return readUserVersion(db)
        } finally {
          db.close()
        }
      } catch {
        return null
      }
    },

    invalidate: release,
    close: release
  }
}

/**
 * Bring a database up to the current schema, or REFUSE to touch it.
 *
 * Three cases, and the third is the one that matters:
 *
 * - **v0** (an empty file, or none) gets both tenants created from scratch.
 * - **an older stamp** walks UP one version at a time through `UPGRADES` — a
 *   v1 database gets the ledger tables and then the map-site column in the same
 *   open. Every step is additive: nothing existing is dropped, rewritten or
 *   reshaped, so an upgrade cannot lose a project even if it fails halfway.
 * - **anything else refuses**, leaving the file untouched. The JSON stores
 *   discard a document whose version they do not know (domain/ledger.ts:294-306)
 *   and that is right for a document the app rebuilds from what it observes
 *   next. A database is the opposite case: discarding it deletes history no
 *   poll regenerates, silently, at startup, on the machine of whoever
 *   downgraded. A user can be told; a deleted table cannot be untold.
 *
 * A DOWNGRADED app still refuses this v2 file, and that is correct rather than
 * unfortunate. A v1 build has no `materials` table in its vocabulary, so it
 * would not read the vault; what it WOULD do is keep writing
 * material-ledger-v1.json, whose last line is the pre-migration snapshot.
 * Accruing onto that stale snapshot and then upgrading again would credit every
 * delta twice. Refusing costs the downgraded run its project list and leaves
 * the vault on the JSON file it never stopped trusting — which is the same
 * degraded-but-honest shape openLedgerStore lands on, and it is recoverable by
 * upgrading again.
 *
 * Each version step is one transaction with its own stamp, so a crash can only
 * leave the version it started from. A half-created database carrying tables
 * with no stamp would refuse itself forever, which is why the stamp is never a
 * separate statement.
 */
export function prepareAppSchema(db: WritableSqliteDb): void {
  const version = readUserVersion(db)
  if (version === APP_SCHEMA_VERSION) return

  if (version === 0) {
    if (hasTable(db, 'projects')) {
      throw new UnsupportedSchemaError(
        'app database carries a projects table with no version stamp; this build will not guess at it'
      )
    }
    inTransaction(db, () => {
      db.exec(CREATE_PROJECTS)
      db.exec(CREATE_LEDGER)
      db.exec(`PRAGMA user_version = ${APP_SCHEMA_VERSION}`)
    })
    return
  }

  if (version >= 1 && version < APP_SCHEMA_VERSION) {
    // Plain CREATE and plain ADD COLUMN, never IF NOT EXISTS: each transaction
    // below is what makes a partial upgrade impossible, so a table or column
    // already standing here means something this code did not write, and
    // adopting it blind would hand a tenant a shape it cannot count on.
    for (const upgrade of UPGRADES) {
      if (upgrade.from < version) continue
      inTransaction(db, () => {
        upgrade.apply(db)
        db.exec(`PRAGMA user_version = ${upgrade.from + 1}`)
      })
    }
    return
  }

  throw new UnsupportedSchemaError(
    `app database is schema version ${version}, this build knows ${APP_SCHEMA_VERSION}`
  )
}

function inTransaction(db: WritableSqliteDb, work: () => void): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    work()
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // A transaction that never opened needs no rolling back.
    }
    throw error
  }
}

export function readUserVersion(db: WritableSqliteDb): number {
  const [row] = db.all('PRAGMA user_version')
  const raw = row?.user_version
  return typeof raw === 'number' ? raw : Number(raw ?? 0)
}

function hasTable(db: WritableSqliteDb, name: string): boolean {
  return (
    db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]).length > 0
  )
}
