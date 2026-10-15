// The launching module's wiring (05 §3.5, §4; 16 §4.5, §8.2, §8.3; 14 §2.3 B-M33, §2.4 B-F18,
// B-F19, §4.1 `launches`; ISSUE-162), in two parts, as routes/askingRoutes.ts:
//
// - `serveLaunching`, run by the composition root before the boot binds the endpoint: B-M33
//   `launching.launch` and the snapshot's `launches` section, so every `hello.ok` lists them
//   (14 §1.3); the launch frames (`LAUNCHING_FRAMES`) are advertised with the endpoint's frame list.
//   They forward to the one instance boot step 4 constructs; until then the dispatcher answers
//   HOST_NOT_READY (14 §3.3).
// - `wire`, run by boot step 4 once suppliers, conversation, crew and mines exist: the module over
//   the SQLite stores (`launches`, `processes`, `launch_records`), the `SessionStarter` bridge over
//   the suppliers registry (bridges/sessionStarter.ts), and the routes below.
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
// - `LaunchFailed` → `launch.failed` (14 §2.4 B-F19), only when a `ui` connection is attached right
//   now, then launching's `failureSeen` (`launches.seen_at`, 14 §8 I-03). A failure no UI saw is
//   never sent later and never listed (PO #65; INV-53; FM-135): it is not put in the replay ring
//   either, so a window that resumes its subscription gets no frame for it.
// - `LaunchedSessionCrashed` → `toast {kind: 'session-crashed', dwarfId, launchId}` (14 §2.4
//   B-F28, §3.6 `HostToast`; PO #62), for `ui`, enqueued before the dwarf's `dwarf.departed` (07
//   S2.07). Launching never publishes it for a dwarf the current Host recovery covers (05 §4
//   "suppressed"; ADR-015 item 5; application/sessionExited.ts), so the route needs no filter of
//   its own. `toast` is advertised with the board frames (frames/board.ts `BOARD_FRAMES`).
// - `DriverSessionExited` (08 §2.4; 15 §1.4 row `exited`): `routeSessionExits` is the suppliers
//   event sink's exit route — launching's PO #62 check with crew's pending end for the dwarf
//   (`CrewQueries.get`), then crew `sessionClosed` with `departureCause(pendingEnd, owned)` from
//   launching's ownership (INV-30); a dwarf already gone, or covered by the current recovery, does
//   not depart here. The composition root hands it to suppliers' sink with the launching wiring
//   (later: ISSUE-182); until then `suppliersWiring.ts` delivers driver events nowhere. Its
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
//   toast of its own (`routeStops`). `routeStopAll`, which host/main.ts subscribes with the
//   `stopAll` binding.
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
  type Launching,
  type LaunchingCommands,
  type LaunchingEvent,
  type StopAllIncomplete
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
import { registerLaunchesSection, toLaunchWire } from '../../transport/snapshot/launchesSection'
import type { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { createSessionStarter } from '../bridges/sessionStarter'

/** The frames the launching wiring publishes, for `hello.ok.capabilities` (14 §1.3). */
export const LAUNCHING_FRAMES: readonly HostFrameName[] = Object.freeze([
  'launch.changed',
  'launch.failed'
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
    events.subscribe('LaunchedSessionCrashed', (event) => {
      const { dwarfId, launchId } = event.payload
      frames.publishFrame('toast', { kind: 'session-crashed', dwarfId, launchId })
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

export interface StopAllRouteDeps {
  /** Launching's `StopAllIncomplete` on the Host bus (08 §0). */
  events: Pick<DomainEventBus<StopAllIncomplete>, 'subscribe'>
  frames: Pick<LaunchFramePublisher, 'publishFrame'>
}

/**
 * The 05 §4 route of `StopAllIncomplete`: the one `toast {stop-all-incomplete}` naming every dwarf
 * Stop everything and quit could not end (08 §2.5; ADR-014 item 9). host/main.ts subscribes it with
 * the `stopAll` binding (ISSUE-175). Returns the unsubscribe.
 */
export function routeStopAll(deps: StopAllRouteDeps): () => void {
  return deps.events.subscribe('StopAllIncomplete', ({ payload }) => {
    const { requestId, ended, failed } = payload
    deps.frames.publishFrame('toast', {
      kind: 'stop-all-incomplete',
      requestId,
      ended: [...ended],
      failed: [...failed]
    })
  })
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
  suppliers: Pick<Suppliers, 'registry' | 'sessions' | 'catalogue' | 'bindings'>
  mines: Pick<MinesQueries, 'get' | 'folderOf'>
  crew: Pick<CrewCommands, 'arrive' | 'sessionClosed'>
  conversation: Pick<ConversationCommands, 'ingest'>
}

export interface WiredLaunching {
  readonly launching: Launching
  /** Unsubscribes the routes (the clean exit). */
  stop(): void
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
  registerLaunchesSection(serve.sections, {
    launches: { snapshot: () => current().launching.snapshots.snapshot() }
  })
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
  const launching = createLaunching({
    launches: new SqliteLaunchStore({
      db,
      scope: transactions,
      clock,
      folderOf: (mineId) => deps.mines.folderOf(mineId)
    }),
    processes: new SqliteProcessRecordStore({ db, scope: transactions, clock, ids: deps.ids }),
    records: new SqliteLaunchRecordStore({ db, scope: transactions }),
    transactions,
    starter: createSessionStarter({
      registry: suppliers.registry,
      sessions: suppliers.sessions,
      clock,
      scheduler: deps.scheduler
    }),
    suppliers: {
      registry: suppliers.registry,
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
    log: deps.log
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
  return {
    launching,
    stop: () => {
      for (const unroute of unrouted) unroute()
    }
  }
}
