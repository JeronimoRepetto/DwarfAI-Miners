// The `SqliteDatabase` double (16 §3, transplanted from today's `adapters/memoryWritableSqlite.ts`,
// adapted to the kernel port). Never imported by production code (R14).
//
// - It runs the caller's REAL SQL on a real SQLite, in memory: a canned result would hide a wrong
//   column or predicate. It is the real `NodeSqliteDatabase` over a private shared-cache memory
//   database, so `openReader()` and a test's competing connection reach the same data. The one
//   policy difference: an in-memory database cannot use WAL, so its journal mode is `memory`.
// - `failWith(code)` makes every statement on the writer throw that `SQLITE_*` error until it is
//   cleared: a full disk or a corrupt file cannot be produced on demand from a real file, and a
//   caller never tested against them would hide them (the FM-104 fault injection).
// - Each instance owns its own database, gone once every connection to it is closed.
import { randomUUID } from 'node:crypto'
import { SqliteInfrastructureError } from '../../../kernel/domain/errors'
import type { SqliteParam, SqliteRow, SqliteRunResult } from '../../../kernel/ports/sqliteDatabase'
import { NodeSqliteDatabase } from '../NodeSqliteDatabase'

const INJECTABLE = {
  SQLITE_BUSY: 5,
  SQLITE_CORRUPT: 11,
  SQLITE_FULL: 13,
  SQLITE_IOERR: 10
} as const

export type InjectedFailure = keyof typeof INJECTABLE

export class MemoryWritableSqlite extends NodeSqliteDatabase {
  private failure: InjectedFailure | null = null

  constructor() {
    super(`file:memory-writable-sqlite-${randomUUID()}?mode=memory&cache=shared`, 'memory')
  }

  /** Make every subsequent statement on the writer fail this way; null restores normal service. */
  failWith(code: InjectedFailure | null): void {
    this.failure = code
  }

  override exec(sql: string): void {
    this.throwInjected()
    super.exec(sql)
  }

  override run(sql: string, params?: readonly SqliteParam[]): SqliteRunResult {
    this.throwInjected()
    return super.run(sql, params)
  }

  override all(sql: string, params?: readonly SqliteParam[]): SqliteRow[] {
    this.throwInjected()
    return super.all(sql, params)
  }

  private throwInjected(): void {
    if (this.failure === null) return
    throw new SqliteInfrastructureError(
      this.failure,
      INJECTABLE[this.failure],
      `MemoryWritableSqlite: injected ${this.failure}`
    )
  }
}
