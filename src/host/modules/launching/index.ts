// The launching module (05 §3.5): the launch lifecycle of ADR-020 in the Host. ISSUE-160 built its
// domain (the `Launch` aggregate and machine 5B, the five-cause classification, the failure and
// its actions, Retry), ISSUE-161 its stores (`launches`, `processes`, `launch_records`), and
// ISSUE-162 the supplier path (Jev off) of `LaunchCommands.launch`:
//
// - `commands.launch` answers `LaunchAccepted` at acceptance, once the `launches` row is committed
//   and `LaunchRequested` published (14 §1.7; 16 §2.9); the launch then continues with no caller
//   through the `SessionStarter` bridge and settles only as `DwarfLaunched` or `LaunchFailed`
//   (application/launch.ts). `commands.failureSeen` records that a failure's `launch.failed` frame
//   reached a `ui` connection (14 §8 I-03).
// - `queries` is 16 §4.5 `LaunchQueries`; `snapshots` is the snapshot `launches` section's read
//   (application/launchQueries.ts).
//
// The other members join with their issues: `launchCustom` (later: ISSUE-165), the Jev path
// (later: ISSUE-164), recovery (later: ISSUE-173), `stopAll` and `markStoppedByPerson` (later:
// ISSUE-175).
import { LaunchUseCase, type LaunchAccepted, type LaunchingDeps } from './application/launch'
import {
  createLaunchQueries,
  LaunchMemory,
  type LaunchQueries,
  type LaunchSnapshotQueries
} from './application/launchQueries'
import type { LaunchId } from '../../kernel/domain/values'
import type { LaunchRequestInput } from './application/launch'

export type { SessionStarter, StartResult } from './ports/sessionStarter'
export type { LaunchStore } from './ports/launchStore'
export type { LaunchRecord, LaunchRecordStore } from './ports/launchRecordStore'
export type { ProcessPurpose, ProcessRecord, ProcessRecordStore } from './ports/processRecordStore'
export type { Launch, LaunchRequest, LaunchState } from './domain/launch'
export type {
  DwarfLaunched,
  LaunchFailed,
  LaunchingEvent,
  LaunchRequested
} from './application/events'
export type { LaunchAccepted, LaunchRefusal, LaunchRequestInput } from './application/launch'
export { LaunchRefusedError } from './application/launch'
export type { LaunchQueries, LaunchSnapshotQueries, LaunchView } from './application/launchQueries'
export {
  classifyLaunchOutcome,
  EARLY_FAILURE_WINDOW_MS,
  HANDSHAKE_TIMEOUT_MS,
  type LaunchOutcomeEvent
} from './domain/classifyLaunchOutcome'
export { buildLaunchFailure } from './domain/launchFailure'
export { NO_SUPPLIER_LABEL } from './domain/supplierLabel'

/** The commands of 16 §4.5 `LaunchCommands` built so far, and the seen record of a failure. */
export interface LaunchingCommands {
  launch(req: LaunchRequestInput): Promise<LaunchAccepted>
  /** A failure's `launch.failed` frame was written to a `ui` connection (14 §8 I-03). */
  failureSeen(launchId: LaunchId): void
}

export interface Launching {
  readonly commands: LaunchingCommands
  readonly queries: LaunchQueries
  readonly snapshots: LaunchSnapshotQueries
}

export type LaunchingModuleDeps = Omit<LaunchingDeps, 'memory'>

export function createLaunching(deps: LaunchingModuleDeps): Launching {
  const memory = new LaunchMemory()
  const useCase = new LaunchUseCase({ ...deps, memory })
  return {
    commands: {
      launch: (req) => useCase.launch(req),
      failureSeen: (launchId) => useCase.failureSeen(launchId)
    },
    queries: createLaunchQueries({ memory, records: deps.records }),
    snapshots: memory
  }
}
