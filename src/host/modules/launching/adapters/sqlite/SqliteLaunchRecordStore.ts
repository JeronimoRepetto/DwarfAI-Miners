// `SqliteLaunchRecordStore` (16 §4.5; 05 §3.5): the `launch_records` table (09 §4.3, D-19), one row
// per owned session, in bound SQL through the kernel `SqliteDatabase` port (R11). Every write joins
// the caller's transaction (16 §2.2): outside one it throws `HostInvariantError` and writes nothing.
//
// - `put` upserts on `launch_id` (the idempotency key). The row's dwarf never changes: a put that
//   names another dwarf for a stored launch is refused, and one that gives a dwarf a second launch's
//   record fails on the `dwarf_id` primary key (a statement failure aborts the command, 16 §2.1).
// - `ref` → `session_ref_json`; `launchOptions` → `profile_*` (its `providerId` is the ref's);
//   `process` → `process_id`, the id of the `processes` row with that exact identity. A process with
//   no row is a code defect (record before acting, 16 §2.2). The FK sets `process_id` to NULL when
//   the process ends, so the record then reads back with no `process`.
// - `endedAt` set → `resume_intent = 0` (09 §4.3 CHECK; ADR-015 item 8).
// - `launchedWithLetJevChoose` is read through the record's launch (09 D-17), never written here.
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import type {
  DwarfId,
  FolderPath,
  HostEpoch,
  Instant,
  LaunchId
} from '../../../../kernel/domain/values'
import type { SqliteDatabase, SqliteRow } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'
import type { SessionProfile } from '../../../crew'
import type { DriverTransport, SessionRef } from '../../../suppliers'
import type { LaunchRecord, LaunchRecordStore } from '../../ports/launchRecordStore'

export interface SqliteLaunchRecordStoreDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

const PROCESS_ID = `SELECT id FROM processes
  WHERE pid = ? AND process_start_time_ms = ? AND boot_id = ?`

const PUT = `INSERT INTO launch_records (dwarf_id, launch_id, driver_transport, session_ref_json, cwd,
    profile_model, profile_effort, profile_permission_mode, process_id, resume_intent,
    stopped_by_person, host_epoch, ended_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (launch_id) DO UPDATE SET
    driver_transport = excluded.driver_transport,
    session_ref_json = excluded.session_ref_json,
    cwd = excluded.cwd,
    profile_model = excluded.profile_model,
    profile_effort = excluded.profile_effort,
    profile_permission_mode = excluded.profile_permission_mode,
    process_id = excluded.process_id,
    resume_intent = excluded.resume_intent,
    stopped_by_person = excluded.stopped_by_person,
    host_epoch = excluded.host_epoch,
    ended_at = excluded.ended_at
  WHERE launch_records.dwarf_id = excluded.dwarf_id`

const REMOVE = 'DELETE FROM launch_records WHERE launch_id = ?'

const STOPPED_BY_PERSON = `UPDATE launch_records SET stopped_by_person = 1
  WHERE dwarf_id = ? AND ended_at IS NULL`

const SELECT = `SELECT r.dwarf_id, r.launch_id, r.driver_transport, r.session_ref_json, r.cwd,
    r.profile_model, r.profile_effort, r.profile_permission_mode, r.resume_intent,
    r.stopped_by_person, r.host_epoch, r.ended_at, l.launched_with_let_jev_choose,
    p.pid, p.process_start_time_ms, p.boot_id
  FROM launch_records r
  JOIN launches l ON l.id = r.launch_id
  LEFT JOIN processes p ON p.id = r.process_id`

const ALL = `${SELECT} ORDER BY r.launch_id`

const LIVE = `${SELECT} WHERE r.ended_at IS NULL ORDER BY r.launch_id`

export class SqliteLaunchRecordStore implements LaunchRecordStore {
  constructor(private readonly deps: SqliteLaunchRecordStoreDeps) {}

  put(r: LaunchRecord): void {
    this.requireTransaction('put')
    const processId = r.process === undefined ? null : this.processIdOf(r.process)
    const ended = r.endedAt !== undefined
    const { changes } = this.deps.db.run(PUT, [
      r.dwarfId,
      r.launchId,
      r.driverTransport,
      JSON.stringify(r.ref),
      r.cwd,
      r.launchOptions.model ?? null,
      r.launchOptions.effort ?? null,
      r.launchOptions.permissionMode ?? null,
      processId,
      r.resumeIntent && !ended ? 1 : 0,
      r.stoppedByPerson ? 1 : 0,
      r.hostEpoch,
      r.endedAt ?? null
    ])
    if (changes === 0) {
      throw new HostInvariantError("a launch's record never changes dwarf (launch_records)")
    }
  }

  remove(id: LaunchId): void {
    this.requireTransaction('remove')
    this.deps.db.run(REMOVE, [id])
  }

  all(): LaunchRecord[] {
    return this.deps.db.all(ALL).map(toRecord)
  }

  markStoppedByPerson(dwarfId: DwarfId): void {
    this.requireTransaction('markStoppedByPerson')
    this.deps.db.run(STOPPED_BY_PERSON, [dwarfId])
  }

  live(): LaunchRecord[] {
    return this.deps.db.all(LIVE).map(toRecord)
  }

  private processIdOf(identity: ProcessIdentity): string {
    const [row] = this.deps.db.all(PROCESS_ID, [
      identity.pid,
      identity.processStartTimeMs,
      identity.bootId
    ])
    if (row === undefined) {
      throw new HostInvariantError(
        'a launch record names a process with no processes row: record the process first (16 §2.2)'
      )
    }
    return String(row['id'])
  }

  private requireTransaction(method: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        `LaunchRecordStore.${method} runs inside the caller's transaction (16 §2.2)`
      )
    }
  }
}

function toRecord(row: SqliteRow): LaunchRecord {
  const ref = JSON.parse(String(row['session_ref_json'])) as SessionRef
  const launchOptions: SessionProfile = { providerId: ref.providerId }
  if (row['profile_model'] !== null) launchOptions.model = String(row['profile_model'])
  if (row['profile_effort'] !== null) launchOptions.effort = String(row['profile_effort'])
  if (row['profile_permission_mode'] !== null) {
    launchOptions.permissionMode = String(row['profile_permission_mode'])
  }
  const record: LaunchRecord = {
    dwarfId: String(row['dwarf_id']) as DwarfId,
    launchId: String(row['launch_id']) as LaunchId,
    ref,
    driverTransport: row['driver_transport'] as DriverTransport,
    cwd: String(row['cwd']) as FolderPath,
    launchOptions,
    launchedWithLetJevChoose: row['launched_with_let_jev_choose'] === 1,
    resumeIntent: row['resume_intent'] === 1,
    stoppedByPerson: row['stopped_by_person'] === 1,
    hostEpoch: String(row['host_epoch']) as HostEpoch
  }
  if (row['pid'] !== null) {
    record.process = {
      pid: Number(row['pid']),
      processStartTimeMs: Number(row['process_start_time_ms']),
      bootId: String(row['boot_id'])
    }
  }
  if (row['ended_at'] !== null) record.endedAt = Number(row['ended_at']) as Instant
  return record
}
