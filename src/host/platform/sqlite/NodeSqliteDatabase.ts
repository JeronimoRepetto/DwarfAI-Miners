// The Host's writing connection over `node:sqlite` `DatabaseSync` (16 §3 `SqliteDatabase`,
// adapter `NodeSqliteDatabase` ← today's `adapters/sqliteWritable.ts`). `node:sqlite` is imported
// only under `host/platform/sqlite/**` (05 R11); if spike SP-04 selects `better-sqlite3`, only
// this folder changes.
//
// - Every connection it opens, the writer and each `openReader()`, carries the 09 §8.1 policy
//   (`connectionPolicy.ts`); a reader is `query_only`.
// - A failing statement throws `SqliteInfrastructureError` with the `SQLITE_*` code (16 §2.1 c).
//   The message is SQLite's own text, which names no bound parameter; errors that are not
//   SQLite results (a wrong parameter type) are programming errors and pass through unchanged.
import { DatabaseSync } from 'node:sqlite'
import { SqliteInfrastructureError } from '../../kernel/domain/errors'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type {
  SqliteDatabase,
  SqliteParam,
  SqliteReader,
  SqliteRow,
  SqliteRunResult
} from '../../kernel/ports/sqliteDatabase'
import { applyConnectionPolicy, type JournalMode } from './connectionPolicy'

/** Primary SQLite result codes (sqlite.org/rescode.html), indexed by their numeric value. */
const PRIMARY_RESULT_NAMES: Readonly<Record<number, string>> = {
  1: 'ERROR',
  2: 'INTERNAL',
  3: 'PERM',
  4: 'ABORT',
  5: 'BUSY',
  6: 'LOCKED',
  7: 'NOMEM',
  8: 'READONLY',
  9: 'INTERRUPT',
  10: 'IOERR',
  11: 'CORRUPT',
  12: 'NOTFOUND',
  13: 'FULL',
  14: 'CANTOPEN',
  15: 'PROTOCOL',
  16: 'EMPTY',
  17: 'SCHEMA',
  18: 'TOOBIG',
  19: 'CONSTRAINT',
  20: 'MISMATCH',
  21: 'MISUSE',
  22: 'NOLFS',
  23: 'AUTH',
  24: 'FORMAT',
  25: 'RANGE',
  26: 'NOTADB'
}

function sqliteErrcode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const { code, errcode } = error as { code?: unknown; errcode?: unknown }
  return code === 'ERR_SQLITE_ERROR' && typeof errcode === 'number' ? errcode : null
}

/** Map a driver error to `SqliteInfrastructureError`; any other error is returned unchanged. */
export function toInfrastructureError(error: unknown): unknown {
  const errcode = sqliteErrcode(error)
  if (errcode === null) return error
  const name = PRIMARY_RESULT_NAMES[errcode & 0xff] ?? 'ERROR'
  const message = error instanceof Error ? error.message : `SQLite result ${errcode}`
  return new SqliteInfrastructureError(`SQLITE_${name}`, errcode, message, { cause: error })
}

function mapped<T>(action: () => T): T {
  try {
    return action()
  } catch (error) {
    throw toInfrastructureError(error)
  }
}

function openConnection(
  location: string,
  role: 'writer' | 'reader',
  journalMode: JournalMode
): DatabaseSync {
  const db = mapped(() => new DatabaseSync(location))
  try {
    mapped(() => applyConnectionPolicy(db, role, journalMode))
  } catch (error) {
    db.close()
    throw error
  }
  return db
}

function allRows(db: DatabaseSync, sql: string, params: readonly SqliteParam[]): SqliteRow[] {
  return mapped(() => db.prepare(sql).all(...params) as SqliteRow[])
}

export interface NodeSqliteOptions {
  /** Where `db.sqlite-error` records go (19 §9.5). */
  log?: DiagnosticsLog
}

export class NodeSqliteDatabase implements SqliteDatabase {
  private readonly db: DatabaseSync

  /**
   * Open (creating it when absent) the database at `location` as the writing connection. Throws
   * `SqliteInfrastructureError` when SQLite refuses the file and `ConnectionPolicyError` when a
   * pragma reads back wrong.
   */
  protected constructor(
    readonly location: string,
    private readonly journalMode: JournalMode,
    protected readonly options: NodeSqliteOptions = {}
  ) {
    this.db = openConnection(location, 'writer', journalMode)
  }

  /** The Host's writer: a database file in WAL mode. */
  static open(location: string, options: NodeSqliteOptions = {}): NodeSqliteDatabase {
    return new NodeSqliteDatabase(location, 'wal', options)
  }

  exec(sql: string): void {
    this.statement(sql, () => this.db.exec(sql))
  }

  run(sql: string, params: readonly SqliteParam[] = []): SqliteRunResult {
    const result = this.statement(sql, () => this.db.prepare(sql).run(...params))
    return { changes: Number(result.changes) }
  }

  all(sql: string, params: readonly SqliteParam[] = []): SqliteRow[] {
    return this.statement(sql, () => this.db.prepare(sql).all(...params) as SqliteRow[])
  }

  openReader(): SqliteReader {
    const db = openConnection(this.location, 'reader', this.journalMode)
    return {
      all: (sql, params = []) => allRows(db, sql, params),
      close: () => db.close()
    }
  }

  close(): void {
    this.db.close()
  }

  /**
   * Every statement on the writer runs through here, inside the error mapping. The fault-injecting
   * test double (`testing/FaultySqlite.ts`) overrides it to fail a statement the way the driver
   * would; production code never does.
   */
  protected intercept<T>(_sql: string, execute: () => T): T {
    return execute()
  }

  private statement<T>(sql: string, execute: () => T): T {
    return mapped(() => this.intercept(sql, execute))
  }
}
