// `LaunchCommands.launch` (05 §3.5; 16 §4.5, §2.9; 14 §1.7; ADR-020 items 4–6; 07 machines 5B
// and 4A; 11 F3; UC-008), the supplier path (Jev off). Two halves:
//
// Acceptance (synchronous, before the answer):
// - Refused before any row (`LaunchRefusedError`; 16 §4.5: no failure result at acceptance): the
//   Jev path while no `LaunchAdvisor` is composed (hidden until built, 21 §1 item 8); a mine that is missing or not enterable, or a request
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
//   spawn tag `v1:<installId>:<launchId>:<hostEpoch>` (ADR-015 item 2), the `PermissionModeSpec` of
//   the requested mode resolved at acceptance (none requested: null), no delegation (its
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
// "Let Jev choose" (ISSUE-164; UC-009; 07 S5.10, S5.12–S5.15; ADR-020 item 2; ADR-028 D2): the row is
// committed in `routing` and the settlement asks Jev through the `LaunchAdvisor` with an
// `AbortSignal`, aborted at `JEV_ROUTING_BUDGET_MS` (16 §6.5). Jev's pick moves it to `resolving`
// and the supplier path above runs with the pick's provider, model and capped effort (S5.12);
// a fallback with the pickers' values launches on them (S5.12); a fallback carrying the configured
// default ends `handed-back` with `LaunchHandedBack{picks}` and no `LaunchFailed` (S5.13, OQ-38 B);
// otherwise nothing went out and it fails with one of the two Jev causes and its reason (S5.14,
// S5.15; domain/jevFallback.ts).
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
//
// "Other…" (`launchCustom`, ISSUE-165; 16 §4.5; ADR-020 item 3; UC-010) shares the acceptance and
// the settlement above whole, so its dwarf is the same as a supplier dwarf (BR-08); its own steps
// are in launchCustom.ts. The command is parsed at acceptance (no shell); a refusal settles
// `could-not-start` before any driver is reached, with the parser's sentence as the log record's
// `msg`; otherwise the "Other…" driver gets the argv as `customArgv` and its program as the install,
// with no detection. Its failures name "The custom command" (US-LAUNCH-006.AC10).
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
  ProviderId,
  Result
} from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { rankForDepth, type CrewCommands } from '../../crew'
import type { MinesQueries } from '../../mines'
import {
  HOSTED_COMMAND_PROVIDER_ID,
  type DriverLaunchRequest,
  type DriverRegistry,
  type DriverSession,
  type DriverTransport,
  type InstalledProvider,
  type PermissionModeSpec,
  type ProviderDriver,
  type SessionBindings,
  type SupplierCatalogueQueries
} from '../../suppliers'
import { applyLaunchEvent, requestLaunch, type Launch, type LaunchRequest } from '../domain/launch'
import {
  decideJevRouting,
  JEV_ROUTING_BUDGET_MS,
  jevFallbackFailure,
  type JevAnswer,
  type JevLaunchCause,
  type JevPick,
  type JevPicks,
  type JevRouting
} from '../domain/jevFallback'
import { buildLaunchFailure } from '../domain/launchFailure'
import { spawnTagFor } from '../domain/spawnTag'
import { CUSTOM_COMMAND_LABEL, NO_SUPPLIER_LABEL } from '../domain/supplierLabel'
import type { LaunchRecordStore } from '../ports/launchRecordStore'
import type { LaunchStore } from '../ports/launchStore'
import type { ProcessRecordStore } from '../ports/processRecordStore'
import type { AbortableLaunchAdvisor } from '../ports/launchAdvisor'
import type { SessionStarter } from '../ports/sessionStarter'
import type { LaunchingEvent } from './events'
import {
  checkCustomCommand,
  customInstall,
  type CustomCommandCheck,
  type LaunchCustomInput
} from './launchCustom'
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
  /**
   * The `LaunchAdvisor` bridge → jev (16 §4.5; later: ISSUE-182). Without it the Jev path is hidden
   * until built (21 §1 item 8): a "Let Jev choose" launch is refused `jev-not-built`.
   */
  advisor?: AbortableLaunchAdvisor
  /** Calls along the launching → suppliers edge (05 §1.3). */
  suppliers: {
    registry: Pick<DriverRegistry, 'drivers'>
    /**
     * The driver a launch of the provider starts through: the one its capability check selected
     * (ADR-009 D4, "first verified wins"; `Suppliers.launchDriver`). Absent (a composition that
     * launches nothing, such as a recovery-only lane): every launch settles `not-installed`.
     */
    launchDriver?: (id: ProviderId) => Promise<ProviderDriver | undefined>
    catalogue: Pick<SupplierCatalogueQueries, 'entry'>
    /**
     * The `PermissionModeSpec` of a mode the supplier's entry offers now, or null (`Suppliers.offeredMode`;
     * ADR-011 item 1): the entry lists mode ids only, and the driver needs the spec (15 §1.2). Absent (a
     * composition that forwards no mode), every requested mode is refused `mode-not-offered` (fail closed).
     */
    offeredMode?: (id: ProviderId, modeId: string) => PermissionModeSpec | null
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
  /** An "Other…" launch: the typed command as parsed at acceptance (launchCustom.ts). */
  custom?: CustomCommandCheck
  /**
   * The spec of the request's permission mode, resolved at acceptance (ADR-011 item 1); absent or null when the
   * request names none. "Other…" never has one (15 §4.11: `stdio-raw` launches with no mode).
   */
  permissionMode?: PermissionModeSpec | null
}

/** What a settlement runs: the driver and its install, or the failure it settles with instead. */
type Resolution =
  | { ok: true; driver: ProviderDriver; install: InstalledProvider; customArgv?: readonly string[] }
  | { ok: false; failure: LaunchFailure; detail?: string }

/** A mine a launch can target: present and enterable (INV-50); a launch never creates one. */
const ENTERABLE: ReadonlySet<string> = new Set(['measuring', 'active'])

export class LaunchUseCase {
  constructor(private readonly deps: LaunchingDeps) {}

  async launch(input: LaunchRequestInput): Promise<LaunchAccepted> {
    const { ids, hostEpoch } = this.deps
    const { delegation } = input
    // "Let Jev choose" (S5.10) needs the advisor; a `jev` way without it is only a delegated worker
    // whose pick fell back.
    const asksJev = input.jevOn && delegation === undefined
    if (asksJev && this.deps.advisor === undefined) throw new LaunchRefusedError('jev-not-built')
    if (input.way.kind === 'jev' && !asksJev && delegation?.fallback === undefined) {
      throw new LaunchRefusedError('jev-not-built')
    }
    const cwd = this.enterableFolder(input.mineId)
    const providerId = input.way.kind === 'supplier' ? input.way.providerId : null
    const entry = providerId === null ? null : this.deps.suppliers.catalogue.entry(providerId)
    if (providerId !== null && entry === null) throw new LaunchRefusedError('unknown-supplier')
    const permissionMode = this.offeredModeSpec(providerId, input.permissionMode)
    this.checkRetry(input.retryOf)
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
    return this.accept(step.value.launch, input.retryOf, {
      // A fallen-back pick names no provider and never reaches a driver (S5.14, S5.15).
      providerId: providerId ?? ('' as ProviderId),
      cwd,
      supplierLabel: entry?.label ?? NO_SUPPLIER_LABEL,
      permissionMode,
      ...(worker === undefined ? {} : { delegation: worker }),
      ...(delegation?.fallback === undefined ? {} : { fallback: delegation.fallback })
    })
  }

  /**
   * 16 §4.5 `launchCustom` ("Other…", ISSUE-165; ADR-020 item 3): the same refusals before any row
   * as `launch` for the mine and a Retry, the command parsed with no shell (launchCustom.ts), then
   * the same acceptance and settlement over the "Other…" driver. A parser refusal is accepted: it
   * settles `could-not-start` with nothing spawned. "Other…" is never Jev's (INV-43): Jev is off.
   */
  async launchCustom(input: LaunchCustomInput): Promise<LaunchAccepted> {
    const cwd = this.enterableFolder(input.mineId)
    this.checkRetry(input.retryOf)
    const custom = checkCustomCommand(input.command)
    const step = requestLaunch<string, WorkerDelegation>({
      id: this.deps.ids.uuidv7() as LaunchId,
      request: {
        mineId: input.mineId,
        way: { kind: 'custom', command: custom.command },
        prompt: input.prompt,
        jevOn: false,
        jevAutoAccept: false
      },
      hostEpoch: this.deps.hostEpoch,
      ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf })
    })
    if (!step.ok) throw new LaunchRefusedError('not-sendable')
    return this.accept(step.value.launch, input.retryOf, {
      providerId: HOSTED_COMMAND_PROVIDER_ID,
      cwd,
      supplierLabel: CUSTOM_COMMAND_LABEL,
      custom
    })
  }

  /**
   * ADR-011 item 1: the spec of the requested mode, re-derived at send time; null when none was requested. A mode the
   * supplier's entry does not offer now, a mode on a launch that names no supplier, and a mode whose spec the catalogue
   * does not answer are refused `mode-not-offered`: never accepted and dropped, never forwarded unchecked.
   */
  private offeredModeSpec(
    providerId: ProviderId | null,
    modeId: string | undefined
  ): PermissionModeSpec | null {
    if (modeId === undefined) return null
    const offered =
      providerId !== null &&
      this.deps.suppliers.catalogue.entry(providerId)?.permissionModes.includes(modeId) === true
    const spec = offered ? (this.deps.suppliers.offeredMode?.(providerId, modeId) ?? null) : null
    if (spec === null) throw new LaunchRefusedError('mode-not-offered')
    return spec
  }

  /** INV-50: the mine's folder, the session's cwd; a missing or unenterable mine is refused. */
  private enterableFolder(mineId: MineId): FolderPath {
    const mine = this.deps.mines.get(mineId)
    const cwd = this.deps.mines.folderOf(mineId)
    if (mine === null || cwd === null || !ENTERABLE.has(mine.state)) {
      throw new LaunchRefusedError('mine-not-enterable')
    }
    return cwd
  }

  /** INV-54: a `retryOf` must name a failed launch whose cause allows Retry. */
  private checkRetry(retryOf: LaunchId | undefined): void {
    if (retryOf === undefined) return
    const failed = this.deps.launches.byId(retryOf)
    if (failed?.state !== 'failed' || failed.failure?.actions.includes('retry') !== true) {
      throw new LaunchRefusedError('not-retryable')
    }
  }

  /**
   * S5.10 / S5.11 and the answer (14 §1.7): the row committed, the launch in Host memory (a Retry's
   * failure leaves the board), `LaunchRequested` published, then the settlement scheduled.
   */
  private accept(
    launch: OwnLaunch,
    retryOf: LaunchId | undefined,
    facts: Omit<Accepted, 'requestedAt'>
  ): LaunchAccepted {
    const { clock, transactions, launches, memory } = this.deps
    transactions.inTransaction(() => launches.put(launch))
    const requestedAt = clock.now()
    memory.put(viewOf(launch, requestedAt))
    if (retryOf !== undefined) memory.forget(retryOf)
    this.publish({
      type: 'LaunchRequested',
      payload: { launchId: launch.id, request: launch.request }
    })
    const accepted: Accepted = { ...facts, requestedAt }
    // The settlement runs with no caller, after the answer was written (14 §1.7).
    this.deps.scheduler.after(0, () => void this.settle(launch, accepted))
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
  private async settle(accepted: OwnLaunch, acceptedFacts: Accepted): Promise<void> {
    let launch = accepted
    let facts = acceptedFacts
    let spawned: ProcessIdentity | undefined
    let settled = false
    const failWith = (failure: LaunchFailure, detail?: string): void => {
      if (settled) return
      settled = true
      this.fail(launch, failure, facts, detail)
    }
    try {
      if (launch.state === 'routing') {
        // A delegated worker: Jev already answered for the subtask (S5.12, S5.14, S5.15).
        if (facts.fallback !== undefined) {
          failWith(this.jevFailure(facts.fallback, facts))
          return
        }
        let pick: JevPick | undefined
        if (facts.delegation === undefined) {
          // A normal launch with "Let Jev choose" (S5.10): Jev is asked now (UC-009).
          const routed = await this.route(launch, facts)
          if (routed.kind === 'failed') {
            failWith(routed.failure)
            return
          }
          if (routed.kind === 'handed-back') {
            settled = true
            this.handBack(launch, routed.picks, facts)
            return
          }
          if (routed.kind === 'picked') {
            pick = routed.pick
            facts = {
              ...facts,
              providerId: pick.providerId,
              supplierLabel:
                this.deps.suppliers.catalogue.entry(pick.providerId)?.label ?? NO_SUPPLIER_LABEL
            }
          }
        }
        launch = this.picked(launch, facts, pick)
      }
      const resolved = await this.resolve(facts)
      if (!resolved.ok) {
        failWith(resolved.failure, resolved.detail)
        return
      }
      const { driver } = resolved
      const { request } = launch
      const req: DriverLaunchRequest = {
        launchId: launch.id,
        install: resolved.install,
        ...(resolved.customArgv === undefined ? {} : { customArgv: resolved.customArgv }),
        cwd: facts.cwd,
        prompt: request.prompt,
        ...runsWith(launch),
        permissionMode: facts.permissionMode ?? null,
        delegation: null,
        spawnTag: spawnTagFor(this.deps.installId, launch.id, launch.hostEpoch),
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
        // An "Other…" failure names "The custom command", not the driver's label (US-LAUNCH-006.AC10).
        failWith(
          facts.custom === undefined
            ? started.error
            : { ...started.error, supplierLabel: facts.supplierLabel }
        )
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

  /**
   * The driver a settlement launches through, the one the provider's capability check selected
   * (ADR-009 D4: the first driver, in preference order, whose probe verified `launch`; GitHub
   * #1431), and its install. A composition without that selection launches nothing (fail closed). A supplier is detected: none, or not installed, is `not-installed` (S5.16). "Other…" is
   * never detected (15 §3 H1): a parser refusal is `could-not-start` before any driver is reached,
   * so nothing spawns (ADR-020 item 3; S5.17); otherwise its own program is the install.
   */
  private async resolve(facts: Accepted): Promise<Resolution> {
    const { custom } = facts
    if (custom !== undefined && !custom.ok) {
      return { ok: false, failure: this.failure('could-not-start', facts), detail: custom.detail }
    }
    const driver = await this.deps.suppliers.launchDriver?.(facts.providerId)
    if (driver !== undefined && custom !== undefined) {
      const { argv } = custom.command
      return { ok: true, driver, install: customInstall(facts.providerId, argv), customArgv: argv }
    }
    const detected = driver === undefined ? null : await driver.detect()
    if (driver === undefined || detected === null || detected.kind !== 'installed') {
      return { ok: false, failure: this.failure('not-installed', facts) }
    }
    return { ok: true, driver, install: detected.install }
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

  /**
   * S5.10 → S5.12–S5.15: asks Jev through the `LaunchAdvisor` with an `AbortSignal` (16 §4.5,
   * §6.5) and decides the way out of `routing` (domain/jevFallback.ts). A call that has not
   * answered within `JEV_ROUTING_BUDGET_MS` is aborted and settles as the `timeout` fallback; a call
   * that rejects is Jev not reached, with no reason it did not name (logged by its code only, ADR-026).
   */
  private async route(launch: OwnLaunch, facts: Accepted): Promise<JevRouting> {
    const ctx = {
      supplierLabel: facts.supplierLabel,
      pickers: launch.request.way.kind === 'supplier'
    }
    const { advisor } = this.deps
    // Refused at acceptance without an advisor; kept total for the type.
    if (advisor === undefined) return decideJevRouting({ ok: false, error: 'jev-unreachable' }, ctx)
    const controller = new AbortController()
    const budget = new Promise<Result<JevAnswer, JevLaunchCause>>((resolve) => {
      controller.signal.addEventListener(
        'abort',
        () => resolve({ ok: true, value: { fallback: 'timeout' } }),
        { once: true }
      )
    })
    const timer = this.deps.scheduler.after(JEV_ROUTING_BUDGET_MS, () => controller.abort())
    try {
      const asked = advisor
        .suggest(launch.request.prompt, launch.request.mineId, { signal: controller.signal })
        .catch((error: unknown): Result<JevAnswer, JevLaunchCause> => {
          this.uncaught(launch.id, error)
          return { ok: false, error: 'jev-unreachable' }
        })
      const answer = await Promise.race([asked, budget])
      return this.withJevReason(launch, decideJevRouting(answer, ctx), answer, ctx.supplierLabel)
    } finally {
      timer.cancel()
    }
  }

  /**
   * ADR-020 D2; 09 §4.3 (`launches` CHECK): a Jev cause always names its reason (ISSUE-182). The
   * advisor's error carries the reason Jev fell back for (`JevAdvisor`, wiring/bridges/
   * launchAdvisor.ts); a call that rejected, or an advisor that names none, gets the reason its cause
   * stands for (`unreachable`: Jev was not reached; `low-confidence`: Jev reached no choice), logged,
   * so the failure can be stored and the launch never stays in `routing`.
   */
  private withJevReason(
    launch: OwnLaunch,
    routing: JevRouting,
    answer: unknown,
    supplierLabel: string
  ): JevRouting {
    if (routing.kind !== 'failed') return routing
    const { cause, jevReason } = routing.failure
    if (
      jevReason !== undefined ||
      (cause !== 'jev-unreachable' && cause !== 'jev-could-not-choose')
    ) {
      return routing
    }
    const named = (answer as { reason?: JevFallbackReason } | null)?.reason
    if (named === undefined) {
      this.deps.log.record({
        level: 'warn',
        event: 'launch.jev-reason-missing',
        subsystem: 'launching',
        causeClass: cause,
        launchId: launch.id
      })
    }
    return {
      kind: 'failed',
      failure: buildLaunchFailure({
        cause,
        supplierLabel,
        jevReason: named ?? (cause === 'jev-unreachable' ? 'unreachable' : 'low-confidence')
      })
    }
  }

  /**
   * S5.13 (OQ-38 B): `handed-back` with the configured default in the picks; no failure and no
   * notice. The launch leaves the board once `LaunchHandedBack` was published.
   */
  private handBack(launch: OwnLaunch, picks: JevPicks, facts: Accepted): void {
    const step = applyLaunchEvent(launch, { t: 'handed-back', picks })
    if (!step.ok) return
    const next = step.value.launch
    this.deps.transactions.inTransaction(() => this.deps.launches.put(next))
    this.deps.memory.put(viewOf(next, facts.requestedAt))
    this.publish({
      type: 'LaunchHandedBack',
      payload: { launchId: launch.id, mineId: launch.request.mineId, picks }
    })
    this.deps.memory.forget(launch.id)
  }

  /**
   * S5.12: Jev's pick (a normal launch), the pickers' values its fallback launches on, or a delegated
   * worker's pick taken as given, moves the launch to `resolving`.
   */
  private picked(launch: OwnLaunch, facts: Accepted, pick?: JevPick): OwnLaunch {
    const step = applyLaunchEvent(launch, {
      t: 'jev-picked',
      ...(pick === undefined ? {} : { pick })
    })
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

  /** S5.21, S4.02: the dwarf arrives, the launch is owned, its session is bound, then published. */
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
      // Owned first: binding delivers the events the driver held until now, an ask among them, and
      // the ask broker reads the dwarf as owned only from this launch record (07 S1.17, ADR-010).
      this.ownSession(launch, next, ref, dwarfId, transport, process, facts)
      this.deps.suppliers.bindings.bind(ref, dwarfId)
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
          ...runsWith(launch),
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
  private fail(launch: OwnLaunch, failure: LaunchFailure, facts: Accepted, detail?: string): void {
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
      launchId: launch.id,
      // A parser refusal's fixed sentence (ADR-020 item 3: diagnostic detail, never notice copy).
      ...(detail === undefined ? {} : { msg: detail })
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
    return jevFallbackFailure(reason, facts.supplierLabel)
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

/** What the driver runs: Jev's pick when it picked (effort as capped, ADR-028 D1), else the request's. */
function runsWith(launch: OwnLaunch): { model?: string; effort?: string } {
  const { model, effort } = launch.pick ?? launch.request
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort })
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
