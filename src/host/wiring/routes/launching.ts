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
import type { CrewCommands } from '../../modules/crew'
import { createLaunching, type Launching, type LaunchingEvent } from '../../modules/launching'
import { SqliteLaunchRecordStore } from '../../modules/launching/adapters/sqlite/SqliteLaunchRecordStore'
import { SqliteLaunchStore } from '../../modules/launching/adapters/sqlite/SqliteLaunchStore'
import { SqliteProcessRecordStore } from '../../modules/launching/adapters/sqlite/SqliteProcessRecordStore'
import type { MinesQueries } from '../../modules/mines'
import type { Suppliers } from '../../modules/suppliers'
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
  /** The Host's one event bus (16 §2.3). */
  bus: DomainEventBus<LaunchingEvent>
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
  crew: Pick<CrewCommands, 'arrive'>
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
  const stop = routeLaunching({
    events: deps.bus,
    launching,
    conversation: deps.conversation,
    frames: deps.frames
  })
  return { launching, stop }
}
