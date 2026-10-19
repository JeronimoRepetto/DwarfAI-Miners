// `SqliteCursorStore` (16 §4.3; 05 §3.3): the stream positions over `source_cursors` (09 §4.2), in
// bound SQL only. The one writer of that table.
//
// - `advance` is an upsert by `stream_id` inside the caller's transaction (16 §2.2); outside one it
//   throws `HostInvariantError`. A lower value or another kind fails the
//   `source_cursors_never_regress` trigger (`CURSOR_REGRESSION`), which aborts the caller's batch
//   (INV-35; ADR-006 item 3); the same value again is a no-op.
// - `updated_at` is the Host clock at the advance; `missing_since` belongs to the retention sweep
//   (09 §7.1) and is never written here.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { Clock } from '../../../kernel/ports/clock'
import type { SqliteDatabase, SqliteRow } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { CursorStore } from '../ports/cursorStore'
import type { Cursor, CursorKind } from '../ports/observationAdapter'

export interface SqliteCursorStoreDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
  clock: Clock
}

const UPSERT = `INSERT INTO source_cursors (stream_id, adapter_id, kind, value, file_identity, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (stream_id) DO UPDATE SET
    kind = excluded.kind,
    value = excluded.value,
    file_identity = excluded.file_identity,
    updated_at = excluded.updated_at`

export class SqliteCursorStore implements CursorStore {
  constructor(private readonly deps: SqliteCursorStoreDeps) {}

  get(source: string): Cursor | null {
    const row = this.deps.db.all(
      'SELECT adapter_id, kind, value, file_identity FROM source_cursors WHERE stream_id = ?',
      [source]
    )[0]
    return row === undefined ? null : fromRow(row)
  }

  advance(source: string, c: Cursor): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        'CursorStore.advance runs inside the caller transaction (16 §2.2)'
      )
    }
    this.deps.db.run(UPSERT, [
      source,
      c.adapterId,
      c.kind,
      c.value,
      c.fileIdentity,
      this.deps.clock.now()
    ])
  }
}

function fromRow(row: SqliteRow): Cursor {
  return {
    adapterId: row['adapter_id'] as string,
    kind: row['kind'] as CursorKind,
    value: Number(row['value']),
    fileIdentity: (row['file_identity'] as string | null) ?? null
  }
}
