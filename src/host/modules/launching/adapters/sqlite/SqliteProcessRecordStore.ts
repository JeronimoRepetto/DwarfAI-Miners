// `SqliteProcessRecordStore` (16 §4.5; 05 §3.5): the `processes` table (09 §4.3), in bound SQL
// through the kernel `SqliteDatabase` port (R11). Every write joins the caller's transaction
// (16 §2.2): outside one it throws `HostInvariantError` and writes nothing.
//
// - `put` keys a process by `(pid, process_start_time_ms, boot_id)` (the table's UNIQUE, ADR-014
//   item 1): a second put of the same identity is a no-op (`ON CONFLICT DO NOTHING`). The row gets
//   a UUIDv7 id from the kernel `IdGenerator` and `recorded_at` from the kernel `Clock`.
// - `ended(pid, at)` deletes the rows of that pid recorded at or before `at` (10 §`processes`:
//   deleted on observed exit); a later process that reused the pid keeps its row. Deleting sets a
//   referencing `launch_records.process_id` to NULL (09 §4.3 FK).
// - `live()` reads every row in recording order.
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { HostEpoch, Instant, LaunchId } from '../../../../kernel/domain/values'
import type { Clock } from '../../../../kernel/ports/clock'
import type { IdGenerator } from '../../../../kernel/ports/idGenerator'
import type { SqliteDatabase, SqliteRow } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'
import type {
  ProcessPurpose,
  ProcessRecord,
  ProcessRecordStore
} from '../../ports/processRecordStore'

export interface SqliteProcessRecordStoreDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
  /** Stamps `recorded_at`. */
  clock: Clock
  /** Mints each row's `id`. */
  ids: IdGenerator
}

const PUT = `INSERT INTO processes (id, pid, process_start_time_ms, boot_id, purpose, launch_id,
    host_epoch, recorded_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (pid, process_start_time_ms, boot_id) DO NOTHING`

const ENDED = 'DELETE FROM processes WHERE pid = ? AND recorded_at <= ?'

const LIVE = `SELECT pid, process_start_time_ms, boot_id, purpose, launch_id, host_epoch
  FROM processes ORDER BY recorded_at, id`

export class SqliteProcessRecordStore implements ProcessRecordStore {
  constructor(private readonly deps: SqliteProcessRecordStoreDeps) {}

  put(p: ProcessRecord): void {
    this.requireTransaction('put')
    const { identity } = p
    this.deps.db.run(PUT, [
      this.deps.ids.uuidv7(),
      identity.pid,
      identity.processStartTimeMs,
      identity.bootId,
      p.purpose,
      p.launchId ?? null,
      p.hostEpoch,
      this.deps.clock.now()
    ])
  }

  ended(pid: number, at: Instant): void {
    this.requireTransaction('ended')
    this.deps.db.run(ENDED, [pid, at])
  }

  live(): ProcessRecord[] {
    return this.deps.db.all(LIVE).map(toRecord)
  }

  private requireTransaction(method: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        `ProcessRecordStore.${method} runs inside the caller's transaction (16 §2.2)`
      )
    }
  }
}

function toRecord(row: SqliteRow): ProcessRecord {
  const record: ProcessRecord = {
    identity: {
      pid: Number(row['pid']),
      processStartTimeMs: Number(row['process_start_time_ms']),
      bootId: String(row['boot_id'])
    },
    purpose: row['purpose'] as ProcessPurpose,
    hostEpoch: String(row['host_epoch']) as HostEpoch
  }
  if (row['launch_id'] !== null) record.launchId = String(row['launch_id']) as LaunchId
  return record
}
