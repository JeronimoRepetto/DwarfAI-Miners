// The launching module's public events this issue publishes (08 §0; 05 §3.5 "Public events"):
// `LaunchRequested`, then exactly one of `DwarfLaunched` / `LaunchFailed` (INV-52). The other
// public events (`LaunchHandedBack`, `LaunchedSessionCrashed`, `HostRecovered`, …) join with their
// issues (later: ISSUE-164, ISSUE-173, ISSUE-175).
//
// - `LaunchRequested` carries the request the person sent, prompt included, in Host memory only
//   (08 §0); the `launches` row never stores the prompt (09 D-16).
// - `DwarfLaunched` (08 §0 `{ launchId; dwarfId; mineId; ref; parentDwarfId?; delegated; prompt }`):
//   the prompt is the dwarf's first message (route of `DwarfLaunched` → conversation `ingest`).
// - `LaunchFailed` (08 §0 `{ launchId; mineId; failure }`): `failure.toolOutputTail` is Host memory
//   only (ADR-020 item 6; INV-55), never persisted or logged.
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { LaunchFailure } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, LaunchId, MineId } from '../../../kernel/domain/values'
import type { SessionRef } from '../../suppliers'
import type { LaunchRequest } from '../domain/launch'

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

export type LaunchingEvent = LaunchRequested | DwarfLaunched | LaunchFailed
