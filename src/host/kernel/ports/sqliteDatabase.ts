// The Host database port (16 §3 `SqliteDatabase`): today's WritableSqliteLike + SqliteLike split,
// kept as two surfaces. The writer is the Host's only writing connection (09 §8.1, ADR-005 item 7);
// `openReader()` gives an extra read connection that is `query_only`. A connection opened through
// this port already carries the 09 §8.1 pragmas.
//
// Error model (16 §2.1): a failing statement throws `SqliteInfrastructureError` (kernel
// `domain/errors`) carrying the `SQLITE_*` code; it aborts the current command. Nothing degrades
// to "no rows": from the Host's own store that would be indistinguishable from an empty table.

/** Value accepted as a bound statement parameter. */
export type SqliteParam = string | number | null

/** One result row, keyed by column name. */
export type SqliteRow = Record<string, unknown>

/** What a statement run for its effect reports. */
export interface SqliteRunResult {
  /** Rows inserted, updated or deleted by the statement. */
  changes: number
}

/** An extra read connection (`PRAGMA query_only = ON`); every write through it fails. */
export interface SqliteReader {
  /** Run one parameterized query for its rows. */
  all(sql: string, params?: readonly SqliteParam[]): SqliteRow[]
  close(): void
}

/** The one writing connection. Writes run inside `TransactionRunner.inTransaction` (16 §2.2). */
export interface SqliteDatabase {
  /** Run one or more statements with no parameters (DDL, PRAGMA, transaction control). */
  exec(sql: string): void
  /** Run one parameterized statement for its effect. */
  run(sql: string, params?: readonly SqliteParam[]): SqliteRunResult
  /** Run one parameterized query for its rows. */
  all(sql: string, params?: readonly SqliteParam[]): SqliteRow[]
  /** Open an extra read connection to the same database; its caller closes it. */
  openReader(): SqliteReader
  close(): void
}
