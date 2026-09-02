import type { SqliteParam, SqliteRow } from './sqliteLike'

/**
 * Tiny write-capable SQLite port — a SIBLING of SqliteLike (#93), never a
 * widening of it.
 *
 * SqliteLike is read-only by construction: it exposes openReadOnly() and a
 * handle with only all() and close(), which is what lets the Codex provider
 * read a foreign database with no way to write to it by accident. Adding exec()
 * or run() there would weaken a guarantee that is doing real work, so the app's
 * own store gets its own port instead. The two share only the row and parameter
 * vocabulary imported above.
 *
 * Error contract — the opposite of SqliteLike's, deliberately. Reading Codex's
 * registry degrades to "no rows" because a Codex build with a different schema
 * must not throw inside a poll tick. The app's OWN store cannot do that: "no
 * rows" from it is indistinguishable from an empty vault, and would report a
 * user's whole history as gone. So every failure here is explicit and
 * classified, and a caller has to decide what to do about it.
 */

export type { SqliteParam, SqliteRow }

/**
 * What went wrong, in the only four kinds a caller can act on differently.
 *
 * 'unavailable' is the runtime having no node:sqlite at all (see the loader
 * below); 'locked' is another process or handle holding the database and is
 * usually worth retrying; 'corrupt' means the bytes are not a database this
 * driver can read and needs the user told, never a silent reset; 'io' is
 * everything else — permissions, a full disk, a path that cannot be created.
 */
export type SqliteFailure = 'unavailable' | 'locked' | 'corrupt' | 'io'

/** A classified failure from the writable port. */
export class SqliteWriteError extends Error {
  constructor(
    readonly failure: SqliteFailure,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'SqliteWriteError'
  }
}

/**
 * Map a driver error onto the four kinds above.
 *
 * SQLite reports these as message text rather than as codes the driver
 * surfaces, so the match is on the substrings SQLite itself uses ("file is not
 * a database" is SQLITE_NOTADB, "malformed" is SQLITE_CORRUPT, "locked" and
 * "busy" are SQLITE_LOCKED and SQLITE_BUSY). Anything unrecognised is 'io',
 * because guessing 'corrupt' at an error nobody has seen would invite a caller
 * to discard a database that was merely unreadable for a moment.
 */
export function classifySqliteFailure(error: unknown): SqliteFailure {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (message.includes('not a database') || message.includes('malformed')) return 'corrupt'
  if (message.includes('corrupt')) return 'corrupt'
  if (message.includes('locked') || message.includes('busy')) return 'locked'
  return 'io'
}

/** One open read-write database handle. Every method throws SqliteWriteError. */
export interface WritableSqliteDb {
  /** Run one or more statements with no parameters (DDL, PRAGMA, transactions). */
  exec(sql: string): void
  /** Run one parameterized statement for its effect. */
  run(sql: string, params?: readonly SqliteParam[]): void
  /** Run one parameterized query for its rows. */
  all(sql: string, params?: readonly SqliteParam[]): SqliteRow[]
  close(): void
}

export interface WritableSqliteLike {
  /**
   * Open `path` for reading and writing, creating the database when it is
   * absent — a first run has no file yet, and that is not a failure.
   * Rejects with SqliteWriteError; it never resolves to a null handle,
   * because the caller must not be able to mistake "could not open" for
   * "opened and empty".
   */
  open(path: string): Promise<WritableSqliteDb>
}

/**
 * Loader for node:sqlite, resolved once and cached.
 *
 * Narrowed to exactly what this port exposes, mirroring sqliteLike.ts:40-46, so
 * an upstream API shift lands in one file. node:sqlite is still flagged
 * experimental by Node itself — verified writable with no flag on the runtime
 * this app ships (Electron 44.1.0 / Node 24.19.0, #93), while the same import
 * under the system Node prints ExperimentalWarning in test output. The import
 * stays lazy for the same reason it is lazy on the read-only side: a runtime
 * without the module must produce an honest 'unavailable', not a module-load
 * crash before the app can say anything.
 */
type DatabaseSyncCtor = new (
  path: string,
  options?: { readOnly?: boolean }
) => {
  exec(sql: string): void
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
  close(): void
}

let databaseSync: DatabaseSyncCtor | null | undefined

async function loadDatabaseSync(): Promise<DatabaseSyncCtor | null> {
  if (databaseSync !== undefined) return databaseSync
  try {
    const mod = (await import('node:sqlite')) as unknown as { DatabaseSync: DatabaseSyncCtor }
    databaseSync = typeof mod.DatabaseSync === 'function' ? mod.DatabaseSync : null
  } catch {
    databaseSync = null
  }
  return databaseSync
}

function toRows(raw: unknown[]): SqliteRow[] {
  return raw.filter((row): row is SqliteRow => typeof row === 'object' && row !== null)
}

/**
 * Wrap the one handle shape both the real driver and the in-memory fake open,
 * so the classification of a failing statement is written once.
 *
 * `close` is passed separately because the fake keeps its backing database
 * alive past the handle, exactly as MemorySqlite does.
 */
export function writableHandle(
  db: {
    exec(sql: string): void
    prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown }
  },
  close: () => void
): WritableSqliteDb {
  return {
    exec(sql) {
      try {
        db.exec(sql)
      } catch (error) {
        throw new SqliteWriteError(classifySqliteFailure(error), 'statement failed', {
          cause: error
        })
      }
    },
    run(sql, params = []) {
      try {
        db.prepare(sql).run(...params)
      } catch (error) {
        throw new SqliteWriteError(classifySqliteFailure(error), 'statement failed', {
          cause: error
        })
      }
    },
    all(sql, params = []) {
      try {
        return toRows(db.prepare(sql).all(...params))
      } catch (error) {
        throw new SqliteWriteError(classifySqliteFailure(error), 'query failed', { cause: error })
      }
    },
    close
  }
}

/** Real node:sqlite implementation used by the running app. */
export class NodeWritableSqlite implements WritableSqliteLike {
  async open(path: string): Promise<WritableSqliteDb> {
    const Ctor = await loadDatabaseSync()
    if (Ctor === null) {
      throw new SqliteWriteError('unavailable', 'node:sqlite is not available in this runtime')
    }

    let db: InstanceType<DatabaseSyncCtor>
    try {
      db = new Ctor(path)
    } catch (error) {
      throw new SqliteWriteError(classifySqliteFailure(error), 'database could not be opened', {
        cause: error
      })
    }

    try {
      // A handle over a non-database file opens without complaint and only
      // fails on the first real read, so the probe happens here: a caller that
      // got a handle back has one it can use. WAL is what Codex's own
      // databases use and is what keeps a crash mid-write from tearing this
      // one — the same guarantee the JSON stores get from tmp+rename.
      db.exec('PRAGMA journal_mode = WAL')
      db.prepare('SELECT count(*) FROM sqlite_master').all()
    } catch (error) {
      try {
        db.close()
      } catch {
        // A handle that never became usable needs no closing.
      }
      throw new SqliteWriteError(classifySqliteFailure(error), 'database could not be read', {
        cause: error
      })
    }

    return writableHandle(db, () => {
      try {
        db.close()
      } catch {
        // A handle that is already gone needs no closing.
      }
    })
  }
}
