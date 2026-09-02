import { DatabaseSync } from 'node:sqlite'
import {
  SqliteWriteError,
  writableHandle,
  type SqliteFailure,
  type WritableSqliteDb,
  type WritableSqliteLike
} from './sqliteWritable'

/**
 * In-memory WritableSqliteLike used by unit tests — the write-side twin of
 * MemorySqlite.
 *
 * Each path gets its own `:memory:` database, created on first open exactly as
 * the real driver creates a file that is not there yet, and outliving every
 * handle so a store that closes and reopens sees what it wrote. It runs the
 * caller's REAL SQL for the same reason MemorySqlite does: a canned result
 * would hide a wrong column name or predicate just as effectively as the
 * detection bug that produced that fake.
 *
 * failWith() exists because the failures this port must not hide — a locked
 * database, a corrupt one, a runtime with no node:sqlite — cannot be produced
 * on demand from a real file, and a store that has never been tested against
 * them is a store that will degrade to "no rows" the first time one happens.
 */
export class MemoryWritableSqlite implements WritableSqliteLike {
  private readonly databases = new Map<string, DatabaseSync>()
  private failure: SqliteFailure | null = null

  /** Make every subsequent open() fail this way; null restores normal service. */
  failWith(failure: SqliteFailure | null): void {
    this.failure = failure
  }

  /** Forget a database, so the next open() starts from an empty file again. */
  remove(path: string): void {
    this.databases.get(path)?.close()
    this.databases.delete(path)
  }

  async open(path: string): Promise<WritableSqliteDb> {
    if (this.failure !== null) {
      throw new SqliteWriteError(this.failure, `MemoryWritableSqlite: forced ${this.failure}`)
    }
    let db = this.databases.get(path)
    if (db === undefined) {
      db = new DatabaseSync(':memory:')
      this.databases.set(path, db)
    }
    // The backing database outlives the handle so a reopen sees the same rows,
    // exactly like a real file on disk.
    return writableHandle(db, () => {})
  }
}
