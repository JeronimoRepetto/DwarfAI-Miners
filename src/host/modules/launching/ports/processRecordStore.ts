// Driven port of launching (05 §3.5, 16 §4.5 `ProcessRecordStore`): the `processes` table
// (09 §4.3), every process the Host started or adopted, by purpose (ADR-015 item 1). `live()` feeds
// the recovery pass and the cleanup sweep. Every write runs inside the caller's transaction
// (16 §2.2) and throws `HostInvariantError` outside one.
//
// - The idempotency key is the full `ProcessIdentity` (pid, process start time, boot id; ADR-014
//   item 1, never a bare pid): a second `put` of the same identity is a no-op, the first record wins.
// - `put` is called right after the OS spawn, before the handshake wait (16 §2.2 record before
//   acting; 07 S4.01), so a crash mid-handshake leaves the row for the recovery pass (CH-11).
// - `ended(pid, at)` drops the records of that pid recorded at or before `at` (10 §`processes`:
//   deleted on observed exit). A process recorded after `at` is a later process that reused the
//   pid, so its record is kept.
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { HostEpoch, Instant, LaunchId } from '../../../kernel/domain/values'

/** 06 §2 `ProcessPurpose` (ADR-015 item 1). */
export type ProcessPurpose = 'session' | 'session-server' | 'mcp-relay' | 'hook-shim' | 'launcher'

/** 06 §8.1 `ProcessRecord` (ADR-015 item 1). */
export interface ProcessRecord {
  identity: ProcessIdentity
  purpose: ProcessPurpose
  launchId?: LaunchId
  hostEpoch: HostEpoch
}

export interface ProcessRecordStore {
  put(p: ProcessRecord): void
  ended(pid: number, at: Instant): void
  /** Every record not ended, in recording order. */
  live(): ProcessRecord[]
}
