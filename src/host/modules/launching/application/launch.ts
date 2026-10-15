// `LaunchCommands.launch` (05 §3.5; 16 §4.5, §2.9; 14 §1.7; ADR-020 items 4–6; 07 machines 5B
// and 4A; 11 F3; UC-008), the supplier path (Jev off). Two halves:
//
// Acceptance (synchronous, before the answer):
// - Refused before any row (`LaunchRefusedError`; 16 §4.5: no failure result at acceptance): the
//   Jev path (ISSUE-164, hidden until built); a mine that is missing or not enterable, or a request
//   that is not sendable (INV-50); a supplier this build's catalogue does not hold; a permission
//   mode that is not among the entry's offered modes now (ADR-011 item 1: re-derived at send time);
//   a `retryOf` that names no failed launch whose cause allows Retry (INV-54).
// - Otherwise the `launches` row is committed in `resolving` (S5.11), the launch joins the Host
//   memory the snapshot reads, `LaunchRequested` is published (its `launch.changed` frame is
//   enqueued before the answer, 14 §1.7) and `LaunchAccepted` answers. A Retry's failure leaves
//   the board then (14 §4.3 rule 7); the new launch is a new `Launch` with `retryOf` (INV-54).
//
// Settlement (no caller; PO #27, #65; INV-53): it starts on the scheduler's next turn, after the
// answer was written, and nothing the UI does — closing the Add panel or the window, detaching —
// reaches it (S5.24). It settles exactly once:
// - detect through the first driver of the registry (ADR-009 D4–D5): none, or not installed, is
//   `not-installed` (S5.16);
// - the `DriverLaunchRequest`: the prompt as the first turn (stdin or protocol, never argv), the
//   spawn tag `v1:<installId>:<launchId>:<hostEpoch>` (ADR-015 item 2), no permission mode (no
//   catalog entry lists one yet, so any requested mode is refused above), no delegation (its
//   `issueFor` is EPIC-12's), and `onSpawned`, which commits the `processes` row and `launches`
//   `spawned` in one transaction right after the OS spawn, before the handshake wait (16 §2.2;
//   S5.18, S4.01; CH-11);
// - `SessionStarter.start` (the bridge: the driver's handshake and the 3-second early window,
//   ADR-020 D4) with the launch's `launchedWithLetJevChoose` (owner amendment N, A14-02);
// - ok (S5.21, S4.02): crew `arrive` (rank from the parent: a root launch is the foreman, `working`
//   with its first message pending, S1.01) along the launching → crew edge, the session bound to
//   that dwarf before the dwarf is published (ADR-015 item 7), one transaction for the
//   `launch_records` row (resume intent set) and `launches` `succeeded`, then `DwarfLaunched`;
// - a failure (S5.16, S5.17, S5.19, S5.20): `launches` `failed` with its cause (never its tail), the
//   failure kept in Host memory with its `toolOutputTail` (ADR-020 item 6; INV-55), one
//   `launch.failed` diagnostics record with the cause only, then `LaunchFailed`. An unexpected
//   error is `could-not-start`, never a sixth cause (INV-52).
//
// A delegated worker (ISSUE-180; ADR-013 items 1, 4; 09 D-17; UC-017), a request with `delegation`
// set, which only the `WorkerLauncher` bridge sends (wiring/bridges/workerLauncher.ts):
// - its row is committed in `routing` (S5.10) with `delegated = 1`, its `delegation_id` and
//   `launched_with_let_jev_choose = 0` (`requestLaunch`; 09 D-17);
// - Jev already picked for the subtask, so the pick is taken as given, never a second Jev call: the
//   settlement moves it to `resolving` (S5.12) and runs the supplier path above; a pick that fell
//   back fails in `routing` with its Jev cause and reason (S5.14, S5.15: a delegated
//   `effort-ceiling` is `jev-could-not-choose`, never `handed-back`, ADR-028 D2);
// - `SessionStarter.start` gets `launchedWithLetJevChoose: false`, so the worker never gets a
//   delegation entry of its own (depth one, INV-81);
// - its dwarf arrives as a `worker` (`rankForDepth(1)`: a delegating dwarf is always a root launch)
//   of the delegating dwarf, `delegated` (INV-27, INV-28; AMENDMENT-15 (owner, 2026-10-15)), and
//   `DwarfLaunched` carries `parentDwarfId` and `delegated: true` (07 S5.21 → S8.03).
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { JevFallbackReason, LaunchFailure } from '../../../kernel/domain/sharedContracts'
import type {
  DwarfId,
  EventId,
  FolderPath,
  HostEpoch,
  Instant,
  LaunchId,
  MineId,
  ProviderId
} from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { rankForDepth, type CrewCommands } from '../../crew'
import type { MinesQueries } from '../../mines'
import type {
  DriverLaunchRequest,
  DriverRegistry,
  DriverSession,
  DriverTransport,
  SessionBindings,
  SupplierCatalogueQueries
} from '../../suppliers'
import { applyLaunchEvent, requestLaunch, type Launch, type LaunchRequest } from '../domain/launch'
import { buildLaunchFailure } from '../domain/launchFailure'
import { NO_SUPPLIER_LABEL } from '../domain/supplierLabel'
import type { LaunchRecordStore } from '../ports/launchRecordStore'
import type { LaunchStore } from '../ports/launchStore'
import type { ProcessRecordStore } from '../ports/processRecordStore'
import type { SessionStarter } from '../ports/sessionStarter'
import type { LaunchingEvent } from './events'
import { viewOf, type LaunchMemory } from './launchQueries'

/** 05 `LaunchRequestInput`: 14 `LaunchParams` without the transport's `requestId`. */
export interface LaunchRequestInput {
  mineId: MineId
  way: { kind: 'supplier'; providerId: ProviderId } | { kind: 'jev' }
  model?: string
  effort?: string
  permissionMode?: string
  prompt: string
  jevOn: boolean
  jevAutoAccept: boolean
  retryOf?: LaunchId
  /**
   * Set only by the `WorkerLauncher` bridge (09 D-17 `LaunchRequest.delegation`): the delegation
   * the worker serves, its delegating dwarf, and Jev's fallback when the subtask's pick fell back
   * (then `way` is `{ kind: 'jev' }`: nothing was picked).
   */
  delegation?: { delegationId: string; parentDwarfId: DwarfId; fallback?: JevFallbackReason }
}

/** 09 D-17: what a delegated worker's `LaunchRequest.delegation` carries. */
interface WorkerDelegation {
  delegationId: string
  parentDwarfId: DwarfId
}

/** ADR-020 D2: the fallbacks where Jev could not be reached (S5.14); the others could not choose (S5.15). */
const JEV_UNREACHABLE: ReadonlySet<JevFallbackReason> = new Set([
  'unreachable',
  'timeout',
  'rate-limited',
  'invalid-response'
])

/**
 * Why a launch is refused before any `launches` row is written (INV-50; ADR-011 item 1): there is
 * no failure result at acceptance (16 §4.5), so a request that cannot become a `Launch` is a
 * refused call, which the transport answers as INVALID_PARAMS (14 §3.3).
 */
export type LaunchRefusal =
  | 'not-sendable' // INV-50: no way to run, or an empty prompt
  | 'mine-not-enterable' // INV-50: a mine that is missing, removed or unenterable
  | 'unknown-supplier' // the provider is not in this build's catalogue
  | 'mode-not-offered' // ADR-011 item 1: the mode is not among the entry's offered modes now
  | 'mode-not-forwardable' // offered, but its PermissionModeSpec cannot reach the driver yet (package gap)
  | 'not-retryable' // INV-54: `retryOf` names no failed launch whose cause allows Retry
  | 'jev-not-built' // the Jev path is ISSUE-164's: hidden until built (21 §1 item 8)

export class LaunchRefusedError extends Error {
  readonly code = 'LAUNCH_REFUSED'

  constructor(readonly reason: LaunchRefusal) {
    super(`launch refused: ${reason}`)
    this.name = 'LaunchRefusedError'
  }
}

/** 14 §3.4 `LaunchAccepted`. */
export interface LaunchAccepted {
  launchId: LaunchId
}

export interface LaunchingDeps {
  launches: LaunchStore
  processes: ProcessRecordStore
  records: LaunchRecordStore
  transactions: TransactionRunner
  starter: SessionStarter
  /** Calls along the launching → suppliers edge (05 §1.3). */
  suppliers: {
    registry: Pick<DriverRegistry, 'drivers'>
    catalogue: Pick<SupplierCatalogueQueries, 'entry'>
    bindings: SessionBindings
  }
  /** Calls along the launching → mines edge: the target mine and its folder, the session's cwd. */
  mines: Pick<MinesQueries, 'get' | 'folderOf'>
  /**
   * Calls along the launching → crew edge: the launched dwarf's arrival, and its departure when the
   * launch fails after it arrived.
   */
  crew: Pick<CrewCommands, 'arrive' | 'sessionClosed'>
  bus: Pick<DomainEventBus<LaunchingEvent>, 'publish'>
  clock: Clock
  /** Starts each settlement after the answer was written. */
  scheduler: Scheduler
  ids: IdGenerator
  hostEpoch: HostEpoch
  /** `app_meta.install_id`, the first field of the spawn tag (ADR-015 item 2). */
  installId: string
  log: DiagnosticsLog
  memory: LaunchMemory
}

/** A launch of this module: the permission mode is carried as its mode id (06 §5.1). */
type OwnLaunch = Launch<string>

/** What the settlement of one accepted launch works with. */
interface Accepted {
  providerId: ProviderId
  cwd: FolderPath
  supplierLabel: string
  requestedAt: Instant
  /** A delegated worker's delegation (09 D-17). */
  delegation?: WorkerDelegation
  /** A delegated worker whose pick fell back: it fails in `routing` (S5.14, S5.15). */
  fallback?: JevFallbackReason
}

/** A mine a launch can target: present and enterable (INV-50); a launch never creates one. */
const ENTERABLE: ReadonlySet<string> = new Set(['measuring', 'active'])

export class LaunchUseCase {
  constructor(private readonly deps: LaunchingDeps) {}

  async launch(input: LaunchRequestInput): Promise<LaunchAccepted> {
    const { clock, ids, hostEpoch, transactions, launches, memory } = this.deps
    const { delegation } = input
    if (input.jevOn) throw new LaunchRefusedError('jev-not-built')
    // A `jev` way is a delegated worker whose pick fell back; any other is the Jev path (ISSUE-164).
    if (input.way.kind === 'jev' && delegation?.fallback === undefined) {
      throw new LaunchRefusedError('jev-not-built')
    }
    const mine = this.deps.mines.get(input.mineId)
    const cwd = this.deps.mines.folderOf(input.mineId)
    if (mine === null || cwd === null || !ENTERABLE.has(mine.state)) {
      throw new LaunchRefusedError('mine-not-enterable')
    }
    const providerId = input.way.kind === 'supplier' ? input.way.providerId : null
    const entry = providerId === null ? null : this.deps.suppliers.catalogue.entry(providerId)
    if (providerId !== null && entry === null) throw new LaunchRefusedError('unknown-supplier')
    if (input.permissionMode !== undefined) {
      // Offered or not, a mode cannot reach the driver yet: suppliers exposes the offered mode ids,
      // never their `PermissionModeSpec`, which `DriverLaunchRequest.permissionMode` needs (15 §1.2;
      // package gap). Refused rather than accepted and dropped.
      throw new LaunchRefusedError(
        entry?.permissionModes.includes(input.permissionMode) === true
          ? 'mode-not-forwardable'
          : 'mode-not-offered'
      )
    }
    if (input.retryOf !== undefined) {
      const failed = launches.byId(input.retryOf)
      if (failed?.state !== 'failed' || failed.failure?.actions.includes('retry') !== true) {
        throw new LaunchRefusedError('not-retryable')
      }
    }
    const worker: WorkerDelegation | undefined =
      delegation === undefined
        ? undefined
        : { delegationId: delegation.delegationId, parentDwarfId: delegation.parentDwarfId }
    const request: LaunchRequest<string, WorkerDelegation> = {
      mineId: input.mineId,
      way: providerId === null ? { kind: 'jev' } : { kind: 'supplier', providerId },
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      prompt: input.prompt,
      jevOn: input.jevOn,
      jevAutoAccept: input.jevAutoAccept,
      ...(worker === undefined ? {} : { delegation: worker })
    }
    const step = requestLaunch({
      id: ids.uuidv7() as LaunchId,
      request,
      hostEpoch,
      ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf })
    })
    if (!step.ok) throw new LaunchRefusedError('not-sendable')
    const launch: OwnLaunch = step.value.launch

    transactions.inTransaction(() => launches.put(launch))
    const requestedAt = clock.now()
    memory.put(viewOf(launch, requestedAt))
    if (input.retryOf !== undefined) memory.forget(input.retryOf)
    this.publish({ type: 'LaunchRequested', payload: { launchId: launch.id, request } })
    const facts: Accepted = {
      // A fallen-back pick names no provider and never reaches a driver (S5.14, S5.15).
      providerId: providerId ?? ('' as ProviderId),
      cwd,
      supplierLabel: entry?.label ?? NO_SUPPLIER_LABEL,
      requestedAt,
      ...(worker === undefined ? {} : { delegation: worker }),
      ...(delegation?.fallback === undefined ? {} : { fallback: delegation.fallback })
    }
    // The settlement runs with no caller, after the answer was written (14 §1.7).
    this.deps.scheduler.after(0, () => void this.settle(launch, facts))
    return { launchId: launch.id }
  }

  /** Records that a failure's `launch.failed` frame reached a `ui` connection (14 §8 I-03). */
  failureSeen(launchId: LaunchId): void {
    if (this.deps.memory.view(launchId)?.state !== 'failed') return
    const at = this.deps.clock.now()
    this.deps.transactions.inTransaction(() => this.deps.launches.markSeen(launchId, at))
    this.deps.memory.markSeen(launchId)
  }

  /** The settlement of one accepted launch; it settles exactly once and never throws. */
  private async settle(accepted: OwnLaunch, facts: Accepted): Promise<void> {
    let launch = accepted
    let spawned: ProcessIdentity | undefined
    let settled = false
    const failWith = (failure: LaunchFailure): void => {
      if (settled) return
      settled = true
      this.fail(launch, failure, facts)
    }
    try {
      if (launch.state === 'routing') {
        // A delegated worker: Jev already answered for the subtask (S5.12, S5.14, S5.15).
        if (facts.fallback !== undefined) {
          failWith(this.jevFailure(facts.fallback, facts))
          return
        }
        launch = this.picked(launch, facts)
      }
      const driver = this.deps.suppliers.registry.drivers(facts.providerId)[0]
      const detected = driver === undefined ? null : await driver.detect()
      if (driver === undefined || detected === null || detected.kind !== 'installed') {
        failWith(this.failure('not-installed', facts))
        return
      }
      const { request } = launch
      const req: DriverLaunchRequest = {
        launchId: launch.id,
        install: detected.install,
        cwd: facts.cwd,
        prompt: request.prompt,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        permissionMode: null,
        delegation: null,
        spawnTag: `v1:${this.deps.installId}:${launch.id}:${launch.hostEpoch}`,
        onSpawned: async (identity) => {
          if (settled || spawned !== undefined) return
          spawned = identity
          launch = this.spawned(launch, identity, facts)
        }
      }
      const started = await this.deps.starter.start(facts.providerId, req, {
        launchedWithLetJevChoose: launch.launchedWithLetJevChoose
      })
      if (!started.ok) {
        failWith(started.error)
        return
      }
      if (settled) return
      if (spawned === undefined) {
        // A driver that never reported its spawn (15 §1.2): the launch cannot leave `resolving`.
        void started.value.close('end-thread')
        failWith(this.failure('could-not-start', facts))
        return
      }
      this.succeed(launch, started.value, driver.transport, spawned, facts)
      settled = true
    } catch (error) {
      this.uncaught(launch.id, error)
      try {
        failWith(this.failure('could-not-start', facts))
      } catch (again) {
        this.uncaught(launch.id, again)
      }
    }
  }

  /** An unexpected error of a settlement: its code only, never its message (ADR-026). */
  private uncaught(launchId: LaunchId, error: unknown): void {
    this.deps.log.record({
      level: 'error',
      event: 'uncaught',
      subsystem: 'launching',
      launchId,
      errCode: errorCodeOf(error)
    })
  }

  /** S5.12: the delegated worker's pick, taken as given, moves it to `resolving`. */
  private picked(launch: OwnLaunch, facts: Accepted): OwnLaunch {
    const step = applyLaunchEvent(launch, { t: 'jev-picked' })
    if (!step.ok) return launch
    const next = step.value.launch
    this.deps.transactions.inTransaction(() => this.deps.launches.put(next))
    this.deps.memory.put(viewOf(next, facts.requestedAt))
    return next
  }

  /** S5.18, S4.01: the `processes` row and `spawned`, in one transaction, before the handshake. */
  private spawned(launch: OwnLaunch, identity: ProcessIdentity, facts: Accepted): OwnLaunch {
    const step = applyLaunchEvent(launch, { t: 'spawned', at: this.deps.clock.now() })
    if (!step.ok) return launch
    const next = step.value.launch
    this.deps.transactions.inTransaction(() => {
      this.deps.processes.put({
        identity,
        purpose: 'session',
        launchId: launch.id,
        hostEpoch: launch.hostEpoch
      })
      this.deps.launches.put(next)
    })
    this.deps.memory.put(viewOf(next, facts.requestedAt))
    return next
  }

  /** S5.21, S4.02: the dwarf arrives, its session is bound, the launch is owned, then published. */
  private succeed(
    launch: OwnLaunch,
    session: DriverSession,
    transport: DriverTransport,
    process: ProcessIdentity,
    facts: Accepted
  ): void {
    const { ref } = session
    const { request } = launch
    const dwarfId = this.deps.crew.arrive({
      mineId: request.mineId,
      identity: {
        providerId: ref.providerId,
        providerSessionId: ref.providerSessionId,
        ...(ref.providerAgentId === undefined ? {} : { providerAgentId: ref.providerAgentId })
      },
      // A delegated worker is one level below its delegating root (INV-27, INV-28; AMENDMENT-15).
      ...(facts.delegation === undefined
        ? { rank: rankForDepth(0) }
        : { parent: facts.delegation.parentDwarfId, rank: rankForDepth(1), delegated: true }),
      status: 'working'
    })
    const step = applyLaunchEvent(launch, { t: 'succeeded', dwarfId })
    if (!step.ok) return
    const next = step.value.launch
    try {
      this.deps.suppliers.bindings.bind(ref, dwarfId)
      this.ownSession(launch, next, ref, dwarfId, transport, process, facts)
    } catch (error) {
      // The arrival committed and published on its own (crew's `arrive` publishes after its own
      // commit, so it cannot join this transaction, 16 §2.3): undo it. The session is ended through
      // its protocol close (ADR-014: a driver falls through to its identity-checked tree kill) and
      // the dwarf walks out; the caller then settles the launch `could-not-start` (INV-52).
      void session.close('end-thread')
      this.deps.crew.sessionClosed(dwarfId, 'crashed')
      throw error
    }
    this.deps.memory.put(viewOf(next, facts.requestedAt))
    this.publish({
      type: 'DwarfLaunched',
      payload: {
        launchId: launch.id,
        dwarfId,
        mineId: request.mineId,
        ref,
        ...(facts.delegation === undefined
          ? { delegated: false }
          : { parentDwarfId: facts.delegation.parentDwarfId, delegated: true }),
        prompt: request.prompt
      }
    })
    // A succeeded launch leaves the board: its dwarf is on it now.
    this.deps.memory.forget(launch.id)
  }

  /** One transaction: the owned session's `launch_records` row and `launches` `succeeded`. */
  private ownSession(
    launch: OwnLaunch,
    next: OwnLaunch,
    ref: DriverSession['ref'],
    dwarfId: DwarfId,
    transport: DriverTransport,
    process: ProcessIdentity,
    facts: Accepted
  ): void {
    const { request } = launch
    this.deps.transactions.inTransaction(() => {
      this.deps.records.put({
        dwarfId,
        launchId: launch.id,
        ref,
        driverTransport: transport,
        cwd: facts.cwd,
        launchOptions: {
          providerId: facts.providerId,
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.effort === undefined ? {} : { effort: request.effort }),
          ...(request.permissionMode === undefined
            ? {}
            : { permissionMode: request.permissionMode })
        },
        launchedWithLetJevChoose: launch.launchedWithLetJevChoose,
        process,
        resumeIntent: true,
        stoppedByPerson: false,
        hostEpoch: launch.hostEpoch
      })
      this.deps.launches.put(next)
    })
  }

  /** S5.16, S5.17, S5.19, S5.20: `failed` with exactly one cause; the tail stays in memory. */
  private fail(launch: OwnLaunch, failure: LaunchFailure, facts: Accepted): void {
    let step = applyLaunchEvent(launch, { t: 'failed', failure })
    if (!step.ok) {
      // A process cause machine 5B does not list from this state (an exit reported for a launch
      // that never reported its spawn): the closest of the five causes, never a sixth (INV-52).
      step = applyLaunchEvent(launch, {
        t: 'failed',
        failure: buildLaunchFailure({
          cause: 'could-not-start',
          supplierLabel: failure.supplierLabel,
          ...(failure.toolOutputTail === undefined
            ? {}
            : { toolOutputTail: failure.toolOutputTail })
        })
      })
    }
    if (!step.ok) return
    const next = step.value.launch
    const settled = next.failure ?? failure
    this.deps.transactions.inTransaction(() => this.deps.launches.put(next))
    this.deps.memory.put(viewOf(next, facts.requestedAt))
    this.deps.log.record({
      level: 'info',
      event: 'launch.failed',
      subsystem: 'launching',
      outcome: 'failed',
      causeClass: settled.cause,
      provider: facts.providerId,
      launchId: launch.id
    })
    this.publish({
      type: 'LaunchFailed',
      payload: { launchId: launch.id, mineId: launch.request.mineId, failure: settled }
    })
  }

  /** A launching-side failure, labelled with the supplier's chip label (US-LAUNCH-006.AC10). */
  private failure(cause: 'not-installed' | 'could-not-start', facts: Accepted): LaunchFailure {
    return buildLaunchFailure({ cause, supplierLabel: facts.supplierLabel })
  }

  /** S5.14, S5.15: a delegated worker's fallen-back pick, with its reason (ADR-020 D2; ADR-028 D2). */
  private jevFailure(reason: JevFallbackReason, facts: Accepted): LaunchFailure {
    return buildLaunchFailure({
      cause: JEV_UNREACHABLE.has(reason) ? 'jev-unreachable' : 'jev-could-not-choose',
      supplierLabel: facts.supplierLabel,
      jevReason: reason
    })
  }

  private publish(event: Pick<LaunchingEvent, 'type' | 'payload'>): void {
    this.deps.bus.publish({
      ...event,
      v: 1,
      id: this.deps.ids.uuidv7() as EventId,
      at: this.deps.clock.now(),
      hostEpoch: this.deps.hostEpoch
    } as LaunchingEvent)
  }
}

/** The error's own code, for the diagnostics record; never its message (ADR-026). */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' || typeof code === 'number') return String(code)
    if (error instanceof Error) return error.name
  }
  return 'unknown'
}
