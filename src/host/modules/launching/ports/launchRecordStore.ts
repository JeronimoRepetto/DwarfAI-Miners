// Driven port of launching (05 §3.5, 16 §4.5 `LaunchRecordStore`): the `launch_records` table
// (09 §4.3), one row per owned session (glossary "Owned session"), what ADR-015 item 5 stores at
// launch to recover it. Every write runs inside the caller's transaction (16 §2.2) and throws
// `HostInvariantError` outside one.
//
// - The idempotency key is `launchId`: a second `put` of the same launch updates its record. A
//   dwarf has one record; a `put` that gives a dwarf a second launch's record is refused (throws).
// - `process` is stored as a reference to its `processes` row (09 D-19 `process_id`), so the
//   process is recorded first (16 §2.2): a `put` naming an identity with no live `ProcessRecord`
//   throws `HostInvariantError`. Once that process is ended its record is gone, and the launch
//   record reads back with no `process`.
// - An ended record never keeps a resume intent (09 §4.3 CHECK; ADR-015 item 8): `put` stores
//   `resumeIntent = false` whenever `endedAt` is set.
// - `launchedWithLetJevChoose` is read through the record's `Launch` (06 §8.1; 09 D-17), never
//   stored a second time; `put` ignores it.
// - `markStoppedByPerson` sets `stoppedByPerson` on the dwarf's live record (no `endedAt`) and is
//   idempotent; a dwarf with no live record is left alone.
// - `all()` and `live()` list records in launch order (`launchId`, UUIDv7).
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type {
  DwarfId,
  FolderPath,
  HostEpoch,
  Instant,
  LaunchId
} from '../../../kernel/domain/values'
import type { SessionProfile } from '../../crew'
import type { DriverTransport, SessionRef } from '../../suppliers'

/** 06 §8.1 `LaunchRecord` (ADR-015 item 5). It carries no status (07 §4A derives it). */
export interface LaunchRecord {
  dwarfId: DwarfId
  launchId: LaunchId
  ref: SessionRef
  driverTransport: DriverTransport
  cwd: FolderPath
  launchOptions: SessionProfile
  launchedWithLetJevChoose: boolean
  process?: ProcessIdentity
  resumeIntent: boolean
  stoppedByPerson: boolean
  hostEpoch: HostEpoch
  endedAt?: Instant
}

export interface LaunchRecordStore {
  put(r: LaunchRecord): void
  remove(id: LaunchId): void
  all(): LaunchRecord[]
  markStoppedByPerson(dwarfId: DwarfId): void
  /** Live = no `endedAt` (owned sessions). */
  live(): LaunchRecord[]
}
