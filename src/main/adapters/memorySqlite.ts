import { DatabaseSync } from 'node:sqlite'
import type { SqliteDb, SqliteLike, SqliteRow } from './sqliteLike'

/**
 * In-memory SqliteLike used by unit tests.
 *
 * Each defined path gets its own `:memory:` database seeded with the exact
 * CREATE TABLE / INSERT statements the test declares — no disk, no Codex
 * install, fully deterministic. It runs the provider's REAL SQL rather than
 * matching canned queries, which is the point: issue #1 was a detection bug
 * that unit tests could not see, and a stubbed query result would have hidden
 * a wrong column name or predicate just as effectively.
 */
export class MemorySqlite implements SqliteLike {
  private readonly databases = new Map<string, DatabaseSync>()

  /**
   * Register a database at `path`. `schema` is the DDL (one or more
   * statements); `seed` holds the INSERT statements for its rows.
   */
  define(path: string, schema: string, seed: readonly string[] = []): void {
    const db = this.databases.get(path) ?? new DatabaseSync(':memory:')
    db.exec(schema)
    for (const statement of seed) db.exec(statement)
    this.databases.set(path, db)
  }

  /** Run extra statements against an already-defined database (e.g. new rows mid-test). */
  exec(path: string, statement: string): void {
    const db = this.databases.get(path)
    if (db === undefined) throw new Error(`MemorySqlite: no database defined at ${path}`)
    db.exec(statement)
  }

  /** Forget a database so openReadOnly() reports it missing. */
  remove(path: string): void {
    this.databases.get(path)?.close()
    this.databases.delete(path)
  }

  async openReadOnly(path: string): Promise<SqliteDb | null> {
    const db = this.databases.get(path)
    if (db === undefined) return null
    return {
      all(sql, params = []): SqliteRow[] {
        try {
          return db.prepare(sql).all(...params)
        } catch {
          // Same contract as the real adapter: a query the schema cannot
          // answer means "no rows", never a thrown scan.
          return []
        }
      },
      // The backing database outlives the handle so repeated scans keep
      // seeing the same rows, exactly like a real file on disk.
      close(): void {}
    }
  }
}
