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
// - `commands.markStoppedByPerson` (ISSUE-171) is the required route target of crew's
//   `DwarfStopRequested`: the person's stop is committed on the dwarf's live record before the end
//   runs (16 §2.3; application/markStoppedByPerson.ts).
// - `commands.sessionExited` is launching's half of `DriverSessionExited` (ISSUE-176; 05 §4;
//   PO #62): an owned session's record ends (`ended_at`, `resume_intent = 0`), and an owned session
//   nobody stopped that is not covered by the current Host recovery publishes
//   `LaunchedSessionCrashed` (application/sessionExited.ts). `recovery` is the current Host
//   recovery's coverage; no recovery runs in the Host yet (later: ISSUE-173 makes it launching's
//   own), so it defaults to `NO_HOST_RECOVERY`.
//
// The other members join with their issues: `launchCustom` (later: ISSUE-165), the Jev path
// (later: ISSUE-164), recovery (later: ISSUE-173), `stopAll` (later: ISSUE-175).
import { LaunchUseCase, type LaunchAccepted, type LaunchingDeps } from './application/launch'
import { MarkStoppedByPerson } from './application/markStoppedByPerson'
import {
  createLaunchQueries,
  LaunchMemory,
  type LaunchQueries,
  type LaunchSnapshotQueries
} from './application/launchQueries'
import {
  NO_HOST_RECOVERY,
  SessionExitedCheck,
  type RecoveryCoverage,
  type SessionExit,
  type SessionExitResult
} from './application/sessionExited'
import type { DwarfId, LaunchId } from '../../kernel/domain/values'
import type { LaunchRequestInput } from './application/launch'

export type { SessionStarter, StartResult } from './ports/sessionStarter'
export type { LaunchStore } from './ports/launchStore'
export type { LaunchRecord, LaunchRecordStore } from './ports/launchRecordStore'
export type { ProcessPurpose, ProcessRecord, ProcessRecordStore } from './ports/processRecordStore'
export type { Launch, LaunchRequest, LaunchState } from './domain/launch'
export type {
  DwarfLaunched,
  LaunchedSessionCrashed,
  LaunchFailed,
  LaunchingEvent,
  LaunchRequested
} from './application/events'
export { NO_HOST_RECOVERY } from './application/sessionExited'
export type { RecoveryCoverage, SessionExit, SessionExitResult } from './application/sessionExited'
export type { LaunchAccepted, LaunchRefusal, LaunchRequestInput } from './application/launch'
export { LaunchRefusedError } from './application/launch'
export { createLaunchDrainGate } from './application/launchDrain'
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
  /** Launching's half of `DriverSessionExited`: the record ends; PO #62's check (08 §2.4). */
  sessionExited(exit: SessionExit): SessionExitResult
  /** Route of `DwarfStopRequested` (why ≠ 'host-recovery'): `stopped_by_person` BEFORE the end (PO #62). */
  markStoppedByPerson(dwarfId: DwarfId): void
}

export interface Launching {
  readonly commands: LaunchingCommands
  readonly queries: LaunchQueries
  readonly snapshots: LaunchSnapshotQueries
}

export type LaunchingModuleDeps = Omit<LaunchingDeps, 'memory'> & {
  /** The current Host recovery's coverage; `NO_HOST_RECOVERY` until one runs (later: ISSUE-173). */
  recovery?: RecoveryCoverage
}

export function createLaunching(deps: LaunchingModuleDeps): Launching {
  const memory = new LaunchMemory()
  const useCase = new LaunchUseCase({ ...deps, memory })
  const stops = new MarkStoppedByPerson({ records: deps.records, transactions: deps.transactions })
  const exits = new SessionExitedCheck({
    records: deps.records,
    transactions: deps.transactions,
    recovery: deps.recovery ?? NO_HOST_RECOVERY,
    bus: deps.bus,
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch,
    log: deps.log
  })
  return {
    commands: {
      launch: (req) => useCase.launch(req),
      failureSeen: (launchId) => useCase.failureSeen(launchId),
      sessionExited: (exit) => exits.exited(exit),
      markStoppedByPerson: (dwarfId) => stops.mark(dwarfId)
    },
    queries: createLaunchQueries({ memory, records: deps.records }),
    snapshots: memory
  }
}
