// Driven port of launching (05 §3.5, 16 §4.5 `LaunchStore`): the `launches` table (09 §4.3), one
// row per `Launch` aggregate (06 §8.1) from Send to settlement. The idempotency key is `launch_id`:
// a second `put` of the same id updates that row. Every write runs inside the caller's transaction
// (16 §2.2) and throws `HostInvariantError` outside one.
//
// A launch moves forward only (07 machine 5B): `put` refuses, by throwing `HostInvariantError`, a
// state that goes back (`spawned` → `resolving`) or rewrites a settled launch with another state.
// `markSeen` is a code defect (it throws) unless the launch is `failed`; the first instant wins.
//
// What reads back (lead decision, ISSUE-161): `launches` stores the request's facts, not the whole
// aggregate, so a launch read back carries
// - `request.prompt` = '' (09 D-16: the prompt is the first `messages` row, never stored here);
// - `request.jevOn` = `launchedWithLetJevChoose` (`launched_with_let_jev_choose` is
//   `LaunchRequest.jevOn`, 10 §`launches`; a delegated worker's launch stores 0, 09 D-17);
// - `request.permissionMode` as the mode id string the request carried (06 §5.1 strings);
// - `request.delegation` as `{ delegationId, parentDwarfId }` (09 D-17: the parent is reached
//   through `delegations`);
// - `failure` with its `cause` and `jevReason` (09 §4.3 `failure_cause`, `jev_reason`). Its
//   `toolOutputTail` is never stored (ADR-020 item 6). `supplierLabel` has no column (package gap):
//   the SQLite adapter rebuilds the failure with the domain's generic label, so a caller that
//   renders the notice after a Host restart re-derives the chip label from `request.way`.
import type { Instant, LaunchId } from '../../../kernel/domain/values'
import type { Launch } from '../domain/launch'

export interface LaunchStore {
  put(l: Launch): void
  byId(id: LaunchId): Launch | null
  /** Not yet succeeded, failed or handed back: `routing`, `resolving` or `spawned` (INV-53). */
  inFlight(): Launch[]
  /** A failure was written to a ui connection (14 §8 I-03). */
  markSeen(id: LaunchId, at: Instant): void
}
