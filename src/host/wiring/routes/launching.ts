// The launching module's wiring (05 §3.5, §4; 16 §4.5, §8.2, §8.3; 14 §2.3 B-M33, §2.4 B-F18,
// B-F19, §4.1 `launches`; ISSUE-162), in two parts, as routes/askingRoutes.ts:
//
// - `serveLaunching`, run by the composition root before the boot binds the endpoint: B-M33
//   `launching.launch`, B-M34 `launching.launchCustom` (ISSUE-165), B-M35
//   `launching.retryRecovery`, B-M36 `launching.dismissRecovery` (ISSUE-174), and the snapshot's
//   `launches` and `recovery` sections, so every `hello.ok` lists them (14 §1.3); the launch and
//   report frames (`LAUNCHING_FRAMES`) are advertised with the endpoint's frame list.
//   They forward to the one instance boot step 4 constructs; until then the dispatcher answers
//   HOST_NOT_READY (14 §3.3).
// - `wire`, run by boot step 4 once suppliers, conversation, crew and mines exist: the module over
//   the SQLite stores (`launches`, `processes`, `launch_records`), the `SessionStarter` bridge over
//   the suppliers registry (bridges/sessionStarter.ts), the `LaunchAdvisor` bridge → jev
//   (bridges/launchAdvisor.ts, ISSUE-182) when the root passes one, and the routes below. Its `recover` builds
//   the Host recovery once crew, suppliers and conversation exist (host/main.ts, boot step 4) and
//   routes its report (`routeRecovery`, ISSUE-174); until then B-M35 / B-M36 answer `no-report`
//   and the `recovery` section is null.
//
// Routes (05 §4; 08 §0), each through the target module's public API only (R4, R15):
// - `LaunchRequested` → `launch.changed` with the launch in flight (14 §2.4 B-F18).
// - `DwarfLaunched` → conversation `ingest` of the prompt as the dwarf's first message (the
//   person's own words, US-LAUNCH-005.AC07), then `launch.changed` with the launch `succeeded`.
//   The arrival itself (crew `arrive`, rank from the parent, `working`) runs inside launching,
//   before `DwarfLaunched` is published, along the launching → crew edge (05 §1.3): the event
//   carries the dwarf's id, the `launch_records` row references the dwarf row (09 §4.3
//   `dwarf_id REFERENCES dwarfs`), and the session is bound to the dwarf before the dwarf is
//   published (07 S4.02; ADR-015 item 7). Package gap, resolved in development: 05 §4 lists
//   crew `arrive` as a route of `DwarfLaunched`, which the foreign key and the event's own
//   `dwarfId` rule out; its `dwarf.arrived` frame is crew's (`DwarfArrived`, frames/board.ts).
// - `LaunchHandedBack` → `launch.changed` with the launch `handed-back` and the picks it put into the
//   pickers (14 §2.4 B-F18, §3.6 `LaunchWire.picks`; 07 S5.13; ADR-028 D2, OQ-38 B): no failure, so
//   no `launch.failed` (ISSUE-182, forward note of #1401).
// - `LaunchFailed` → `launch.failed` (14 §2.4 B-F19), only when a `ui` connection is attached right
//   now, then launching's `failureSeen` (`launches.seen_at`, 14 §8 I-03). A failure no UI saw is
//   never sent later and never listed (PO #65; INV-53; FM-135): it is not put in the replay ring
//   either, so a window that resumes its subscription gets no frame for it.
// - `HostRecovered`, `RecoveryRetried`, `RecoveryRetryFailed`, `RecoveryDismissed` → the
//   `host.recovered` frame and crew's walk-outs (14 §2.4 B-F21; ADR-015 item 5): `routeRecovery`.
// - `LaunchedSessionCrashed` → `toast {kind: 'session-crashed', dwarfId, launchId}` (14 §2.4
//   B-F28, §3.6 `HostToast`; PO #62), for `ui`, enqueued before the dwarf's `dwarf.departed` (07
//   S2.07). Launching never publishes it for a dwarf the current Host recovery covers (05 §4
//   "suppressed"; ADR-015 item 5; application/sessionExited.ts), so the route needs no filter of
//   its own. `toast` is advertised with the board frames (frames/board.ts `BOARD_FRAMES`).
// - `DriverSessionExited` (08 §2.4; 15 §1.4 row `exited`): `routeSessionExits` is the suppliers
//   event sink's exit route — launching's PO #62 check with crew's pending end for the dwarf
//   (`CrewQueries.get`), then crew `sessionClosed` with `departureCause(pendingEnd, owned)` from
//   launching's ownership (INV-30); a dwarf already gone, or covered by the current recovery, does
//   not depart here. The composition root hands it to suppliers' sink with the other driver event
//   routes (wiring/launchedSessions.ts, routes/driverEvents.ts; ISSUE-182). Its
//   `DriverSessionExited` → conversation `recordSessionEnd` row is the departure's own route
//   (`DwarfDeparted`, routes/cut1Routes.ts), idempotent per dwarf.
// - `DwarfStopRequested` (crew; why ≠ `host-recovery`) → launching `markStoppedByPerson`, the bus's
//   one required handler (16 §2.3, AR-24; ISSUE-171): `stopped_by_person` is committed before
//   `SessionTerminator.end` runs, so the exit raises no PO #62 toast (FM-060). If it throws, the
//   crew command ends nothing and answers `could-not-end`. `routeStops`.
// - `DwarfStopFailed{why: 'stop-dwarf'}` (crew) → the one `toast {kind: 'dwarf-stop-failed',
//   requestId, dwarfId}` (14 §2.4 B-F28; ADR-014 item 6), for `ui`; a failed Remove mine, stop-all or
//   delegation end sends none per dwarf (their one grouped message is their owner's). `toast` is
//   advertised with the board frames (frames/board.ts `BOARD_FRAMES`). `routeStops`.
// - `StopAllIncomplete` (launching; ISSUE-175) → the one `toast {kind: 'stop-all-incomplete',
//   requestId, ended, failed}` (14 §2.4 B-F28, §3.6 `HostToast`; 05 §4; 08 §2.5; ADR-014 item 9):
//   ONE danger message naming every dwarf Stop everything and quit could not end, for `ui`. It is
//   published only with `failed ≠ ∅` (16 §4.5), and no `DwarfStopFailed{why: 'stop-all'}` raises a
//   toast of its own (`routeStops`).
//
// The frames are the same for every `ui` connection, whatever its mode (US-LAUNCH-006.AC13). They
// are sensitive (14 §3.5 SENSITIVE_FRAMES); nothing here logs their data.
import type { HostFrameData, HostFrameName } from '@dwarfai/contracts'
import type { HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { HostInvariantError } from '../../kernel/domain/errors'
import type { ConversationCommands } from '../../modules/conversation'
import {
  departureCause,
  type CrewCommands,
  type CrewEndEvent,
  type CrewQueries
} from '../../modules/crew'
import {
  createLaunching,
  type AbortableLaunchAdvisor,
  type Launching,
  type LaunchingCommands,
  type LaunchingEvent,
  type LaunchingRecovery,
  type LaunchingRecoveryDeps,
  type ProcessRecordStore,
  type RecoveryReportView
} from '../../modules/launching'
import { SqliteLaunchRecordStore } from '../../modules/launching/adapters/sqlite/SqliteLaunchRecordStore'
import { SqliteLaunchStore } from '../../modules/launching/adapters/sqlite/SqliteLaunchStore'
import { SqliteProcessRecordStore } from '../../modules/launching/adapters/sqlite/SqliteProcessRecordStore'
import type { MinesQueries } from '../../modules/mines'
import type { SuppliedEventSink, Suppliers } from '../../modules/suppliers'
import type { Dispatcher } from '../../transport/dispatcher'
import type { AttachedConnection } from '../../transport/connectionRegistry'
import type { FrameAudience } from '../../transport/events/framePublisher'
import { registerLaunchingLaunch } from '../../transport/methods/launchingLaunch'
import { registerLaunchingLaunchCustom } from '../../transport/methods/launchingLaunchCustom'
import { registerLaunchingDismissRecovery } from '../../transport/methods/launchingDismissRecovery'
import { registerLaunchingRetryRecovery } from '../../transport/methods/launchingRetryRecovery'
import { registerLaunchesSection, toLaunchWire } from '../../transport/snapshot/launchesSection'
import {
  registerRecoverySection,
  toHostRecoveryReportView
} from '../../transport/snapshot/recoverySection'
import type { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { createSessionStarter } from '../bridges/sessionStarter'
import type { DelegationLifecycle } from '../../modules/delegation'

/** The frames the launching wiring publishes, for `hello.ok.capabilities` (14 §1.3). */
export const LAUNCHING_FRAMES: readonly HostFrameName[] = Object.freeze([
  'launch.changed',
  'launch.failed',
  'host.recovered'
])

/** Where the launch frames go: the connection registry (transport/connectionRegistry.ts). */
export interface LaunchFramePublisher {
  publishFrame<F extends HostFrameName>(
    name: F,
    data: HostFrameData[F],
    audience?: FrameAudience
  ): void
  /** The connections attached right now: a failure is sent only while a `ui` one is. */
  connections(): readonly Pick<AttachedConnection, 'role'>[]
}

export interface LaunchingRouteDeps {
  events: Pick<DomainEventBus<LaunchingEvent>, 'subscribe'>
  launching: Pick<Launching, 'commands' | 'snapshots'>
  conversation: Pick<ConversationCommands, 'ingest'>
  frames: LaunchFramePublisher
}

/** The 05 §4 routes of launching's events and their frames; returns the unsubscribe. */
export function routeLaunching(deps: LaunchingRouteDeps): () => void {
  const { events, launching, conversation, frames } = deps
  const changed = (launchId: Parameters<Launching['snapshots']['view']>[0]): void => {
    const view = launching.snapshots.view(launchId)
    if (view !== null) frames.publishFrame('launch.changed', { launch: toLaunchWire(view) })
  }
  const stops = [
    events.subscribe('LaunchRequested', (event) => changed(event.payload.launchId)),
    events.subscribe('DwarfLaunched', (event) => {
      const { launchId, dwarfId, prompt } = event.payload
      conversation.ingest(
        dwarfId,
        [
          {
            sourceKey: `dwarfai:launch:${launchId}:prompt`,
            role: 'person',
            text: prompt,
            providerTime: null
          }
        ],
        'live-stream'
      )
      changed(launchId)
    }),
    events.subscribe('LaunchHandedBack', (event) => changed(event.payload.launchId)),
    events.subscribe('LaunchedSessionCrashed', (event) => {
      const { dwarfId, launchId } = event.payload
      frames.publishFrame('toast', { kind: 'session-crashed', dwarfId, launchId })
    }),
    events.subscribe('StopAllIncomplete', (event) => {
      const { requestId, ended, failed } = event.payload
      frames.publishFrame('toast', {
        kind: 'stop-all-incomplete',
        requestId,
        ended: [...ended],
        failed: [...failed]
      })
    }),
    events.subscribe('LaunchFailed', (event) => {
      const { launchId, mineId, failure } = event.payload
      if (!frames.connections().some((connection) => connection.role === 'ui')) return
      frames.publishFrame('launch.failed', { launchId, mineId, failure: { ...failure } })
      launching.commands.failureSeen(launchId)
    })
  ]
  return () => {
    for (const stop of stops) stop()
  }
}

export interface RecoveryRouteDeps {
  /** Launching's report events on the Host bus. */
  events: Pick<DomainEventBus<LaunchingEvent>, 'subscribe'>
  recovery: Pick<LaunchingRecovery, 'report' | 'view' | 'shown' | 'retryRecovery'>
  crew: { commands: Pick<CrewCommands, 'sessionClosed'> }
  frames: LaunchFramePublisher
}

export interface RoutedRecovery {
  /** B-M35's command: Retry, then the settled report's frame before the answer (14 §2.4 B-F21). */
  retryRecovery: LaunchingRecovery['retryRecovery']
  /** Unsubscribes the routes. */
  stop(): void
}

/**
 * The 05 §4 routes of the Host recovery report (ADR-015 item 5; 08 §0): `HostRecovered` → the one
 * `host.recovered` frame, to the first `ui` client, which marks it shown (none attached: the
 * snapshot `recovery` section carries it); `RecoveryRetried` → the frame (`retrying`);
 * `RecoveryRetryFailed` → crew `sessionClosed('recovery-failed')`, then the frame; `RecoveryDismissed`
 * → crew `sessionClosed('recovery-dismissed')` per listed dwarf (crew keeps one whose session runs,
 * S2.19), then the frame (`settled`). A retry that settled re-sends it once more (`settled`). No
 * route raises a toast or an OS notification (PO #62; ADR-018 D3).
 */
export function routeRecovery(deps: RecoveryRouteDeps): RoutedRecovery {
  const { events, recovery, crew, frames } = deps
  const publish = (view: RecoveryReportView | null): void => {
    if (view !== null)
      frames.publishFrame('host.recovered', { report: toHostRecoveryReportView(view) })
  }
  const stops = [
    events.subscribe('HostRecovered', () => {
      if (!frames.connections().some((connection) => connection.role === 'ui')) return
      publish(recovery.report())
      recovery.shown()
    }),
    events.subscribe('RecoveryRetried', () => publish(recovery.view())),
    events.subscribe('RecoveryRetryFailed', ({ payload }) => {
      crew.commands.sessionClosed(payload.dwarfId, 'recovery-failed')
      publish(recovery.view())
    }),
    events.subscribe('RecoveryDismissed', ({ payload }) => {
      for (const dwarfId of payload.dwarfIds)
        crew.commands.sessionClosed(dwarfId, 'recovery-dismissed')
      publish(recovery.view())
    })
  ]
  return {
    retryRecovery: async (hostEpoch, requestId) => {
      const result = await recovery.retryRecovery(hostEpoch, requestId)
      if (result.ok) publish(result.value)
      return result
    },
    stop: () => {
      for (const stop of stops) stop()
    }
  }
}

export interface SessionExitRouteDeps {
  launching: { commands: Pick<Launching['commands'], 'sessionExited'> }
  crew: {
    queries: Pick<CrewQueries, 'get'>
    commands: Pick<CrewCommands, 'sessionClosed'>
  }
}

/**
 * The 05 §4 route of a driver's `exited` (`DriverSessionExited`, 08 §2.4), as suppliers' event
 * sink: launching's PO #62 check with the dwarf's pending end, then crew's departure with the cause
 * `departureCause` gives from the ownership launching answered (INV-30). Every other driver event
 * is left to its own consumer's route.
 */
export function routeSessionExits(deps: SessionExitRouteDeps): SuppliedEventSink {
  const { launching, crew } = deps
  return {
    deliver: ({ dwarfId, event }) => {
      if (event.t !== 'exited') return
      const dwarf = crew.queries.get(dwarfId)
      const pendingEnd = dwarf?.pendingEnd ?? null
      const present = dwarf !== null && !dwarf.departed
      const { owned, covered } = launching.commands.sessionExited({ dwarfId, pendingEnd, present })
      if (!present || covered) return
      const cause = departureCause(pendingEnd, owned)
      if (cause !== null) crew.commands.sessionClosed(dwarfId, cause)
    }
  }
}

export interface StopRouteDeps {
  /** Crew's end events on the Host bus (16 §2.3). */
  events: Pick<DomainEventBus<CrewEndEvent>, 'subscribe'>
  launching: { commands: Pick<LaunchingCommands, 'markStoppedByPerson'> }
  frames: Pick<LaunchFramePublisher, 'publishFrame'>
}

/**
 * The 05 §4 routes of crew's end events: `DwarfStopRequested` → launching `markStoppedByPerson`,
 * the one required handler (16 §2.3, AR-24), and `DwarfStopFailed{why: 'stop-dwarf'}` → the one
 * `toast {dwarf-stop-failed}` (ADR-014 item 6). Returns the unsubscribe.
 */
export function routeStops(deps: StopRouteDeps): () => void {
  const { events, launching, frames } = deps
  const stops = [
    events.subscribe(
      'DwarfStopRequested',
      ({ payload }) => {
        if (payload.why !== 'host-recovery') launching.commands.markStoppedByPerson(payload.dwarfId)
      },
      { required: true }
    ),
    events.subscribe('DwarfStopFailed', ({ payload }) => {
      if (payload.why !== 'stop-dwarf') return
      const { requestId, dwarfId } = payload
      frames.publishFrame('toast', { kind: 'dwarf-stop-failed', requestId, dwarfId })
    })
  ]
  return () => {
    for (const stop of stops) stop()
  }
}

export interface LaunchingServeDeps {
  /** The Host dispatcher (hostDispatcher.ts), where B-M33 joins. */
  dispatcher: Dispatcher
  /** The snapshot sections, where the `launches` section joins. */
  sections: SectionRegistry
}

export interface LaunchingWiringDeps {
  /** The Host's one writer (09 §8.1), opened by boot step 2. */
  db: SqliteDatabase
  /** Its transaction runner, also the bus's transaction scope (16 §2.2). */
  transactions: TransactionRunner & TransactionScope
  /** The Host's one event bus (16 §2.3): launching publishes; crew's end events are read. */
  bus: DomainEventBus<LaunchingEvent> & Pick<DomainEventBus<CrewEndEvent>, 'subscribe'>
  clock: Clock
  /** Runs the continuation after the answer, the handshake budget and the early window. */
  scheduler: Scheduler
  ids: IdGenerator
  hostEpoch: HostEpoch
  /** `app_meta.install_id`, the first field of the spawn tag (ADR-015 item 2). */
  installId: string
  log: DiagnosticsLog
  frames: LaunchFramePublisher
  suppliers: Pick<
    Suppliers,
    'registry' | 'launchDriver' | 'sessions' | 'catalogue' | 'bindings' | 'releases'
  >
  mines: Pick<MinesQueries, 'get' | 'folderOf'>
  crew: Pick<CrewCommands, 'arrive' | 'sessionClosed'>
  conversation: Pick<ConversationCommands, 'ingest'>
  /**
   * The `LaunchAdvisor` bridge → jev (bridges/launchAdvisor.ts; ISSUE-182). Without it a "Let Jev
   * choose" launch is refused `jev-not-built` (hidden until built, 21 §1 item 8).
   */
  advisor?: AbortableLaunchAdvisor
  /**
   * The delegation lifecycle the `SessionStarter` bridge asks before each driver start (16 §5.3;
   * ISSUE-209). Without it every launch starts with no relay entry.
   */
  delegation?: Pick<DelegationLifecycle, 'issueFor' | 'revokeLaunch'>
}

export interface WiredLaunching {
  readonly launching: Launching
  /**
   * The `processes` records (16 §4.5 `ProcessRecordStore`): the boot cleanup pass reads the helpers
   * a dead epoch left (wiring/helperCleanup.ts; ADR-015 item 6; ISSUE-209).
   */
  readonly processes: ProcessRecordStore
  /**
   * Builds the Host recovery (ISSUE-173; `Launching.recovery`) once, and routes its report
   * (`routeRecovery`, ISSUE-174): B-M35, B-M36 and the `recovery` section serve it from then on.
   */
  recover(deps: LaunchingRecoveryDeps): LaunchingRecovery
  /** The routed Host recovery, once `recover` ran. */
  readonly recovery: RoutedLaunchingRecovery | null
  /** Unsubscribes the routes (the clean exit). */
  stop(): void
}

/** The Host recovery with its routed Retry (the settled report's frame before the answer). */
export interface RoutedLaunchingRecovery {
  readonly recovery: LaunchingRecovery
  readonly routed: RoutedRecovery
}

export interface ServedLaunching {
  wire(deps: LaunchingWiringDeps): WiredLaunching
}

export function serveLaunching(serve: LaunchingServeDeps): ServedLaunching {
  let served: WiredLaunching | undefined
  const current = (): WiredLaunching => {
    if (served === undefined)
      throw new HostInvariantError('launching is served from boot step 4 on')
    return served
  }
  registerLaunchingLaunch(serve.dispatcher, {
    launching: { launch: (req) => current().launching.commands.launch(req) }
  })
  registerLaunchingLaunchCustom(serve.dispatcher, {
    launching: { launchCustom: (req) => current().launching.commands.launchCustom(req) }
  })
  registerLaunchesSection(serve.sections, {
    launches: { snapshot: () => current().launching.snapshots.snapshot() }
  })
  const recovered = (): RoutedLaunchingRecovery | null => served?.recovery ?? null
  registerLaunchingRetryRecovery(serve.dispatcher, {
    recovery: {
      retryRecovery: (hostEpoch, requestId) =>
        recovered()?.routed.retryRecovery(hostEpoch, requestId) ??
        Promise.resolve({ ok: false, error: 'no-report' })
    }
  })
  registerLaunchingDismissRecovery(serve.dispatcher, {
    recovery: {
      dismissRecovery: (hostEpoch, requestId) =>
        recovered()?.recovery.dismissRecovery(hostEpoch, requestId) ?? {
          ok: false,
          error: 'no-report'
        }
    }
  })
  registerRecoverySection(serve.sections, { recovery: () => recovered()?.recovery ?? null })
  return {
    wire: (deps) => {
      if (served !== undefined) throw new HostInvariantError('launching is wired once')
      served = wireLaunching(deps)
      return served
    }
  }
}

function wireLaunching(deps: LaunchingWiringDeps): WiredLaunching {
  const { db, transactions, clock, suppliers } = deps
  const processes = new SqliteProcessRecordStore({ db, scope: transactions, clock, ids: deps.ids })
  const launching = createLaunching({
    launches: new SqliteLaunchStore({
      db,
      scope: transactions,
      clock,
      folderOf: (mineId) => deps.mines.folderOf(mineId)
    }),
    processes,
    records: new SqliteLaunchRecordStore({ db, scope: transactions }),
    transactions,
    starter: createSessionStarter({
      launchDriver: suppliers.launchDriver,
      sessions: suppliers.sessions,
      releases: suppliers.releases,
      clock,
      scheduler: deps.scheduler,
      ...(deps.delegation === undefined
        ? {}
        : {
            delegation: {
              lifecycle: deps.delegation,
              mechanismOf: (providerId) => suppliers.catalogue.capabilities(providerId).mcpInjection
            }
          })
    }),
    suppliers: {
      registry: suppliers.registry,
      launchDriver: suppliers.launchDriver,
      catalogue: suppliers.catalogue,
      bindings: suppliers.bindings
    },
    mines: deps.mines,
    crew: deps.crew,
    bus: deps.bus,
    clock,
    scheduler: deps.scheduler,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch,
    installId: deps.installId,
    log: deps.log,
    ...(deps.advisor === undefined ? {} : { advisor: deps.advisor })
  })
  const unrouted = [
    routeLaunching({
      events: deps.bus,
      launching,
      conversation: deps.conversation,
      frames: deps.frames
    }),
    routeStops({ events: deps.bus, launching, frames: deps.frames })
  ]
  let recovery: RoutedLaunchingRecovery | null = null
  return {
    launching,
    processes,
    recover: (recoveryDeps) => {
      if (recovery !== null) throw new HostInvariantError('the Host recovery is built once')
      const built = launching.recovery(recoveryDeps)
      const routed = routeRecovery({
        events: deps.bus,
        recovery: built,
        crew: { commands: deps.crew },
        frames: deps.frames
      })
      unrouted.push(routed.stop)
      recovery = { recovery: built, routed }
      return built
    },
    get recovery() {
      return recovery
    },
    stop: () => {
      for (const unroute of unrouted) unroute()
    }
  }
}
