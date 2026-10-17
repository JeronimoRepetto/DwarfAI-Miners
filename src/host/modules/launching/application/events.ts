// The launching module's public events this issue publishes (08 §0; 05 §3.5 "Public events"):
// `LaunchRequested`, then exactly one of `DwarfLaunched` / `LaunchFailed` / `LaunchHandedBack`
// (INV-52; ISSUE-164), and `LaunchedSessionCrashed` (ISSUE-176), `StopAllIncomplete` (ISSUE-175),
// `HostRecovered` (ISSUE-173) and the report's `RecoveryRetried`, `RecoveryRetryFailed`,
// `RecoveryDismissed` (ISSUE-174).
//
// - `LaunchRequested` carries the request the person sent, prompt included, in Host memory only
//   (08 §0); the `launches` row never stores the prompt (09 D-16).
// - `DwarfLaunched` (08 §0 `{ launchId; dwarfId; mineId; ref; parentDwarfId?; delegated; prompt }`):
//   the prompt is the dwarf's first message (route of `DwarfLaunched` → conversation `ingest`).
// - `LaunchFailed` (08 §0 `{ launchId; mineId; failure }`): `failure.toolOutputTail` is Host memory
//   only (ADR-020 item 6; INV-55), never persisted or logged.
// - `LaunchHandedBack` (08 §0 `{ launchId; mineId; picks }`; 07 S5.13; ADR-028 D2, OQ-38 B): a
//   normal Jev launch whose fallback put the configured default into the pickers; no failure and no
//   notice. Its route is `launch.changed` with state `handed-back` and the picks (14 §2.4 B-F18).
// - `LaunchedSessionCrashed` (08 §0 `{ dwarfId; launchId }`; 08 §2.5): an owned session nobody
//   stopped exited on its own (PO #62; 07 S4.08). Its route is the `toast {session-crashed}` frame
//   (14 §2.4 B-F28). Published only when `stoppedByPerson = false` and the dwarf is not covered by
//   the current Host recovery (application/sessionExited.ts).
// - `StopAllIncomplete` (08 §0 `{ requestId; ended; failed }`; 08 §2.5; ADR-014 item 9): Stop
//   everything and quit could not end every owned session, so the Host keeps running (INV-121).
//   Published by `stopAll` only with `failed ≠ ∅` (16 §4.5; application/stopAll.ts). Its route is
//   the one `toast {stop-all-incomplete}` (14 §2.4 B-F28).
// - `HostRecovered` (08 §0 `{ report }`; 16 §4.5; ADR-015 item 5): once per Host boot, only when the
//   recovery's `unrecovered` is not empty, after every initial resume settled (07 S16.02). Its
//   route is the `host.recovered` frame, to the first `ui` client (wiring/routes/launching.ts).
// - `RecoveryRetried` (08 §0 `{ hostEpoch; requestId; dwarfIds }`): the person pressed Retry, before
//   any outcome; `dwarfIds` are the listed dwarfs still `unrecovered`, re-attempted (07 S16.05).
// - `RecoveryRetryFailed` (08 §0 `{ hostEpoch; dwarfId }`): that dwarf's retried resume failed; its
//   route is crew `sessionClosed('recovery-failed')`, never a PO #62 toast (07 S4.21; OQ-43).
// - `RecoveryDismissed` (08 §0 `{ hostEpoch; dwarfIds }`): the person dismissed the message; its
//   route is crew `sessionClosed('recovery-dismissed')` per listed dwarf, which keeps one whose
//   session runs (07 S2.13, S2.19, S4.22).
// Each of the three re-sends the `host.recovered` frame with the updated report (14 §2.4 B-F21).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { LaunchFailure } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, HostEpoch, LaunchId, MineId } from '../../../kernel/domain/values'
import type { SessionRef } from '../../suppliers'
import type { JevPicks } from '../domain/jevFallback'
import type { LaunchRequest } from '../domain/launch'
import type { HostRecoveryReport } from '../domain/recoveryReport'

export type LaunchRequested = DomainEvent<
  'LaunchRequested',
  { launchId: LaunchId; request: LaunchRequest<string> }
>

export type DwarfLaunched = DomainEvent<
  'DwarfLaunched',
  {
    launchId: LaunchId
    dwarfId: DwarfId
    mineId: MineId
    ref: SessionRef
    parentDwarfId?: DwarfId
    delegated: boolean
    prompt: string
  }
>

export type LaunchFailed = DomainEvent<
  'LaunchFailed',
  { launchId: LaunchId; mineId: MineId; failure: LaunchFailure }
>

export type LaunchHandedBack = DomainEvent<
  'LaunchHandedBack',
  { launchId: LaunchId; mineId: MineId; picks: JevPicks }
>

export type LaunchedSessionCrashed = DomainEvent<
  'LaunchedSessionCrashed',
  { dwarfId: DwarfId; launchId: LaunchId }
>

export type StopAllIncomplete = DomainEvent<
  'StopAllIncomplete',
  { requestId: string; ended: DwarfId[]; failed: DwarfId[] }
>

export type HostRecovered = DomainEvent<'HostRecovered', { report: HostRecoveryReport }>

export type RecoveryRetried = DomainEvent<
  'RecoveryRetried',
  { hostEpoch: HostEpoch; requestId: string; dwarfIds: DwarfId[] }
>

export type RecoveryRetryFailed = DomainEvent<
  'RecoveryRetryFailed',
  { hostEpoch: HostEpoch; dwarfId: DwarfId }
>

export type RecoveryDismissed = DomainEvent<
  'RecoveryDismissed',
  { hostEpoch: HostEpoch; dwarfIds: DwarfId[] }
>

export type LaunchingEvent =
  | LaunchRequested
  | DwarfLaunched
  | LaunchFailed
  | LaunchHandedBack
  | LaunchedSessionCrashed
  | StopAllIncomplete
  | HostRecovered
  | RecoveryRetried
  | RecoveryRetryFailed
  | RecoveryDismissed
