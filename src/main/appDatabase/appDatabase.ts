import {
  NodeWritableSqlite,
  type WritableSqliteDb,
  type WritableSqliteLike
} from '../adapters/sqliteWritable'

/**
 * The one database this app writes: its file, its schema version, and the
 * migrations between versions (#93).
 *
 * It has three tenants — the projects list (src/main/projects/), the material
 * vault (src/main/ledger/) and the launch register (src/main/sessionLaunch/) —
 * and it is a subject of its own precisely because none of them owns it. Before
 * this module the schema lived inside the projects store, which was honest
 * while projects were the only rows in the file; a second tenant made it the
 * wrong home for the version stamp they all depend on.
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

/**
 * The minimum build generation that can read this file without doing damage —
 * a COMPATIBILITY FLOOR, not a change counter (#575).
 *
 * Pinned at 5, the generation the last released build (0.12.0) actually
 * knows. Every migration this app has ever shipped only ADDS a table or a
 * NULLABLE column, and SQLite ignores a column nobody selects — so a build
 * that only understands 5 can safely open a file this build has converged,
 * even though this build's own vocabulary (routed_by_jev included) reaches
 * further than 5 ever described. That is the bug #575 fixes: treating the
 * stamp as "how many changes have shipped" rather than "what does a reader
 * need to know" locked a real user's 0.12.0 install (knows 5) out of a file a
 * dev build had stamped 6 for nothing more than an additive column — 40 mines
 * and 562M mined tokens, otherwise perfectly intact, made unreadable by the
 * stamp alone.
 *
 * Moving this floor is reserved for a change an older reader genuinely could
 * not survive: a dropped table or column, a rename, a reshape, or a backfill
 * that changes what an existing row means. None of the migrations below is
 * any of those, so none of them has ever needed to.
 *
 * PRAGMA user_version stores it. `prepareAppSchema` converges a file to this
 * build's full known shape by presence, not by walking a counter, and stamps
 * the result at this floor rather than at "however many changes have
 * shipped" — see that function's own doc comment for the full policy, and
 * `ADDITIVE_MISSTAMP` below for the one stamp value normalized down rather
 * than read literally.
 */
export const APP_COMPAT_FLOOR = 5

/**
 * The version the ledger's tables arrived in.
 *
 * Read by openLedgerStore to answer one question it cannot otherwise answer: a
 * database stamped below this has never held the vault, so the JSON file is
 * still the current copy. It was the current schema version when the ledger
 * arrived and must NOT be bumped along with APP_COMPAT_FLOOR since — a later
 * additive change, or a later floor correction like #575's, does not move
 * when the ledger moved in.
 */
export const LEDGER_TABLES_SINCE = 2

/**
 * Refusal to touch a database this build did not write and cannot upgrade.
 *
 * `reason` splits two refusals that share a stack trace but not a fix (#572):
 * 'newer' is a stamp ABOVE this build's own — a build released after this one
 * wrote it, so updating the app is the actual remedy — and 'unstamped' is a
 * `projects` table with no version at all, which this build never wrote and
 * will not guess at. Callers two layers up (openProjectsStore, the runtime's
 * refusal sites) need to tell these apart, because only one of them has
 * something to tell the user to DO about it.
 */
export class UnsupportedSchemaError extends Error {
  constructor(
    message: string,
    readonly reason: 'newer' | 'unstamped'
  ) {
    super(message)
  }
}

/**
 * The projects list — slice 1's table, plus the columns v3 and v5 added.
 *
 * added_at and last_opened_at are separate columns because #92 sorts by either,
 * and they answer different questions: one is provenance, the other recency.
 * name_norm is written by both INSERT paths (see projects/projectName.ts) so a
 * search never has to fold a column it is scanning. The three indexes are the
 * three orders #92 asked for; none of them is speculative — and map_site
 * deliberately has none, since the only question asked of it is "which sites
 * are taken", one scan of a table with one row per project the user has ever
 * opened. hidden_at has none for the same reason: it is read as a predicate
 * over that same one-row-per-project table, never searched or ordered by.
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
  map_site INTEGER,
  hidden_at INTEGER
);
CREATE INDEX projects_name_norm ON projects (name_norm);
CREATE INDEX projects_added_at ON projects (added_at);
CREATE INDEX projects_last_opened_at ON projects (last_opened_at);
`

/**
 * Schema v2 — the material vault, moved out of material-ledger-v1.json.
 *
 * Split into three separate CREATE statements, one per table, rather than one
 * script — convergence (see prepareAppSchema) checks and creates EACH table by
 * its own presence, so a crash between two of these three, or a table one of
 * them collides with by name, converges to completion on the next open instead
 * of needing this trio treated as one indivisible unit.
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
const CREATE_MATERIALS = `
CREATE TABLE materials (
  mine_id TEXT NOT NULL,
  material TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  PRIMARY KEY (mine_id, material)
);
`
const CREATE_SESSION_MARKS = `
CREATE TABLE session_marks (
  key TEXT PRIMARY KEY NOT NULL,
  tokens INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
`
const CREATE_LEDGER_META = `
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
 * Schema v4 — what this panel launched, so the exit survives a restart (#231).
 *
 * One row per session this app started and can still end. It is the ONLY place
 * in this database whose rows describe something outside it — a process on this
 * machine — which is why the identity columns are the two of them rather than
 * `pid` alone: a pid is recycled, and this app owns a `taskkill /T` that would
 * take an unrelated process's children with it. `proc_start_ms` is the creation
 * time of that exact process, read while the panel still held the handle, and a
 * row is only ever acted on when the probe answers with it again (see
 * sessionLaunch/launchedSessions.ts).
 *
 * `session_id` rather than a dwarf id: a dwarf id is a reading of the board and
 * is rebuilt every poll, while the session id is the provider's own and is what
 * the next run will see the same session under. Keyed on the launch, because
 * that is what `end` names.
 *
 * No `started_at` beside `proc_start_ms`: the process's own creation time IS
 * when the launch happened, to within the spawn, and it is the column that has
 * to be right. A second one would be a number nothing reads and nothing checks.
 */
const CREATE_LAUNCHED_SESSIONS = `
CREATE TABLE launched_sessions (
  launch_id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mine_path TEXT NOT NULL,
  pid INTEGER NOT NULL,
  proc_start_ms INTEGER NOT NULL,
  routed_by_jev INTEGER
);
`

/**
 * Schema v5 — when the user stopped tracking a mine, so deleting one can be
 * undone (#169).
 *
 * A NULLABLE TIMESTAMP, not a boolean. `NULL` is the only reading that means
 * "the user still tracks this mine", which is what every row that predates
 * this column has to mean — a `NOT NULL DEFAULT 0` flag would have needed a
 * backfill in the very transaction that must not fail, and a boolean would
 * throw away when the decision was made, which is the one fact a support
 * question about a vanished mine actually asks for.
 *
 * DELETION IS LOGICAL HERE AND NOWHERE ELSE. The row stays and its materials
 * stay: the mine leaves the map, the list and the board, and re-adding the same
 * folder finds this same row because identity is the path (mineIdForPath). The
 * only physical delete in the app is Settings → Data Base → Reset metrics, and
 * that one still touches the ledger alone (see MetricsResetResult).
 */
const ADD_HIDDEN_AT = `ALTER TABLE projects ADD COLUMN hidden_at INTEGER`

/**
 * Whether a launch this panel started was routed by Jev's own decision
 * (#511), so the marker survives a restart the same way the rest of
 * `launched_sessions` does. NULL for every row written before this column
 * existed — `toLaunch` (launchedSessionStore.ts) reads that as `false`, which
 * is the honest answer: none of those launches could have been Jev-routed,
 * because the feature did not exist yet.
 *
 * `CREATE_LAUNCHED_SESSIONS` now bakes this column in directly, the same way
 * `CREATE_PROJECTS` bakes in `map_site`/`hidden_at`: convergence (see
 * prepareAppSchema) checks a column's presence before running its ALTER
 * regardless of whether the table was just created in this same pass or
 * already existed, so baking it into the CREATE can no longer collide with
 * this statement — the ALTER below simply finds the column already there and
 * is skipped. It stays a separate convergence step for the one case baking it
 * in does not reach: a `launched_sessions` table that already existed before
 * this column did (#511's own migration, or any database converged by a build
 * before this one).
 *
 * This is also why bumping `APP_COMPAT_FLOOR` for this column would have been
 * wrong even before #575 named the mistake: nothing about adding it required
 * an older reader to understand anything new.
 */
const ADD_ROUTED_BY_JEV = `ALTER TABLE launched_sessions ADD COLUMN routed_by_jev INTEGER`

/**
 * A stamp of 6 was never a real schema break — it was #511's routed_by_jev
 * column, additive like every other migration here, bumping the counter by
 * mistake instead of leaving the floor where it belonged. #575 corrects that:
 * a file carrying this exact stamp converges like any other and is restamped
 * to APP_COMPAT_FLOOR, rather than being refused as "newer" the way a
 * genuinely unknown stamp still is. This is a bounded, one-value transitional
 * rule — it exists because a dev build already shipped 6 before this fix
 * landed, not a general license to keep granting old floors to new stamps.
 * Anything above the floor that is NOT this exact value is still refused.
 */
const ADDITIVE_MISSTAMP = 6

/**
 * Every table this build expects, checked and created by presence — never by
 * `IF NOT EXISTS`, so a name already occupied by something this code did not
 * create (see the rollback test in appDatabase.test.ts) still fails loudly
 * rather than being silently adopted.
 */
const EXPECTED_TABLES: readonly { name: string; create: string }[] = [
  { name: 'projects', create: CREATE_PROJECTS },
  { name: 'materials', create: CREATE_MATERIALS },
  { name: 'session_marks', create: CREATE_SESSION_MARKS },
  { name: 'ledger_meta', create: CREATE_LEDGER_META },
  { name: 'launched_sessions', create: CREATE_LAUNCHED_SESSIONS }
]

/**
 * Every additive column this build expects on a table that might predate it,
 * checked and added by presence. A column already baked into its table's
 * CREATE (map_site and hidden_at into CREATE_PROJECTS, routed_by_jev into
 * CREATE_LAUNCHED_SESSIONS) is present the moment that table is created, so
 * its ALTER here is a no-op on a fresh table and real work only on an older
 * one that predates the column.
 */
const EXPECTED_COLUMNS: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'projects', column: 'map_site', ddl: ADD_MAP_SITE },
  { table: 'projects', column: 'hidden_at', ddl: ADD_HIDDEN_AT },
  { table: 'launched_sessions', column: 'routed_by_jev', ddl: ADD_ROUTED_BY_JEV }
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
 * Bring a database up to this build's full known shape, or REFUSE to touch
 * it (#575).
 *
 * The stamp is read as a FLOOR, not a counter — see APP_COMPAT_FLOOR's own
 * doc comment for what that distinction means and why it matters. That
 * reframing changes what this function does on every path:
 *
 * - **An unstamped file that already has a `projects` table** refuses: this
 *   build never wrote it and will not guess at a version for it. Unchanged
 *   from before #575 — see point 6 of the issue and UnsupportedSchemaError's
 *   own doc comment.
 * - **A stamp above the floor** refuses as 'newer', UNLESS it is exactly
 *   `ADDITIVE_MISSTAMP` (6) — the one stamp a dev build issued for a change
 *   that was additive all along (see that constant's doc comment). Anything
 *   else above the floor is a genuinely breaking change this build does not
 *   know how to read: a drop, a rename, a reshape, or a backfill that changes
 *   what an existing row means, none of which any migration here has ever
 *   been.
 * - **Everything else — 0 through the floor, and the one misstamp above it —
 *   CONVERGES.** `converge` below creates every expected table this build
 *   knows that is missing, and adds every expected column that is missing,
 *   entirely by presence: never a counter walked one step at a time, never an
 *   `IF NOT EXISTS` that would silently adopt a shape this code did not
 *   write. A crash partway through leaves the file exactly where it started
 *   (one transaction — see `converge`); the NEXT open finishes it, because
 *   presence is checked fresh every time rather than resumed from a
 *   remembered step. That is also what makes running this twice on an
 *   already-converged file a genuine no-op: nothing is missing, so nothing
 *   is written.
 *
 * A DOWNGRADED app still refuses a file this build converged, and that is
 * correct rather than unfortunate — but only for a floor it does not know. A
 * v1 build has no `materials` table in its vocabulary, so it would not read
 * the vault; what it WOULD do is keep writing material-ledger-v1.json, whose
 * last line is the pre-migration snapshot. Accruing onto that stale snapshot
 * and then upgrading again would credit every delta twice. Refusing costs the
 * downgraded run its project list and leaves the vault on the JSON file it
 * never stopped trusting — which is the same degraded-but-honest shape
 * openLedgerStore lands on, and it is recoverable by upgrading again. What
 * #575 changes is that this refusal now only fires when the floor a file
 * needs is ABOVE what the reader knows — an additive change no longer raises
 * that floor, so a build far older than "the latest schema change" can still
 * keep reading, exactly as 0.12.0 needed to.
 */
export function prepareAppSchema(db: WritableSqliteDb): void {
  const version = readUserVersion(db)

  if (version === 0 && hasTable(db, 'projects')) {
    throw new UnsupportedSchemaError(
      'app database carries a projects table with no version stamp; this build will not guess at it',
      'unstamped'
    )
  }

  if (version > APP_COMPAT_FLOOR && version !== ADDITIVE_MISSTAMP) {
    throw new UnsupportedSchemaError(
      `app database is schema version ${version}, this build knows ${APP_COMPAT_FLOOR}`,
      'newer'
    )
  }

  if (version === APP_COMPAT_FLOOR && isConverged(db)) return

  converge(db)
}

/** True when every table and column this build expects is already present. */
function isConverged(db: WritableSqliteDb): boolean {
  return (
    EXPECTED_TABLES.every((table) => hasTable(db, table.name)) &&
    EXPECTED_COLUMNS.every((column) => hasColumn(db, column.table, column.column))
  )
}

/**
 * Create every missing table, add every missing column, and stamp the floor —
 * all in ONE transaction, so a failure partway through (an unexpected name
 * collision, a real I/O error) rolls back to exactly the file this open
 * started with, never a half-converged one with a stamp that outruns it.
 */
function converge(db: WritableSqliteDb): void {
  inTransaction(db, () => {
    for (const table of EXPECTED_TABLES) {
      if (!hasTable(db, table.name)) db.exec(table.create)
    }
    for (const column of EXPECTED_COLUMNS) {
      if (!hasColumn(db, column.table, column.column)) db.exec(column.ddl)
    }
    db.exec(`PRAGMA user_version = ${APP_COMPAT_FLOOR}`)
  })
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

/**
 * `table` is always one of this file's own literals (see EXPECTED_COLUMNS),
 * never external input — PRAGMA statements do not accept bound parameters for
 * their own argument, which is why this interpolates rather than binding `?`
 * the way `hasTable` does for a value comparison.
 */
function hasColumn(db: WritableSqliteDb, table: string, column: string): boolean {
  return db.all(`PRAGMA table_info(${table})`).some((row) => row.name === column)
}
