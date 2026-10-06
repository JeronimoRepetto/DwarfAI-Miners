// The mines module's wiring (05 §3.1, §4; 16 §8.2, §8.3), in two parts, as preferencesWiring.ts:
//
// - `serveMines`, run by the composition root before the boot binds the endpoint: the module's
//   seam-B members (14 §2.3 B-M16 `mines.declare`, B-M17 `mines.adoptMainProject`, B-M18
//   `mines.remove`, B-M19 `mines.list`, B-M20 `mines.resolveFile`) on the Host dispatcher and its
//   `mines` snapshot section (14 §4.1), so every `hello.ok` lists them (14 §1.3). They forward to
//   the one instance boot step 4 constructs; until then the dispatcher answers HOST_NOT_READY
//   before any handler runs (14 §3.3), and the section is never read before `ready`.
// - `wire`, run by boot step 4 over the database step 2 opened and the adapters the composition
//   root built (`host/main.ts`, the only file that `new`s them, R6): `createMines` with its scoring
//   walks (`Mines.measurement`, to which `MinesDeps.remeasure` is bound), Remove mine over crew's
//   ends and the walk's abort (`Mines.removal`), the folder-check schedule (`MINE_FOLDER_CHECK_MS`,
//   05 §3.1), the board frames of the mines events (frames/board.ts, 14 §2.4), and the 05 §4 route
//   of this module:
//   - `ProviderErrorObserved` (observation) → `mines.checkFolder` for that dwarf's mine
//     (AMENDMENT-2, SC-AR-04; 07 S3.12 trigger (b)). Its toast is the board frames'.
//   `start`, run after boot step 7 (`BootPorts.startModules`), restarts the walks a stopped Host
//   left (S3.25) and starts the folder-check schedule.
//
// Not routed here, and why:
// - `DriverErrorReported` (suppliers) → `checkFolder`: suppliers publishes no such event yet, and
//   its `ref` → dwarf resolution is launching's (later: EPIC-10).
// - `DwarfArrived` → project recency (08 §2.2): the frozen `MinesCommands` (16 §4.1) has no
//   recency command; an observed arrival lands through `resolveForSession`, which refreshes the
//   mine's `lastUsedAt` itself (07 S3.03), and a launch records it in its own use case.
// - `SessionObserved` → `resolveForSession` → `crew.arrive` (later: ISSUE-094), the Reset step's
//   `walkRecreatedMines` on `MetricsResetStarted` (later: ISSUE-121) and `MineMeasured` → the
//   ledger (later: ISSUE-096).
//
// Crew is not constructed by the Host yet (later: ISSUE-094), so `noCrewYet` stands in: no dwarf
// exists, so a dwarf has no mine, Remove mine has nothing to end, and the board reads no dwarf.
import { defaultConfig } from '@dwarfai/contracts'
import type { DwarfId, HostEpoch, MineId } from '../../kernel/domain/values'
import { HostInvariantError } from '../../kernel/domain/errors'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { FileSystem } from '../../kernel/ports/fileSystem'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import type { CrewEnds, CrewEvent, CrewQueries } from '../../modules/crew'
import {
  createMines,
  DEFAULT_TIER_THRESHOLDS,
  MINE_FOLDER_CHECK_MS,
  type FolderCheckSchedule,
  type MapSite,
  type Mines,
  type MinesCommands,
  type MinesDeps,
  type MinesEvent,
  type MinesQueries,
  type MineWalks,
  type SourceWeightScanner,
  type TierThresholds
} from '../../modules/mines'
import type { ObservationEvent } from '../../modules/observation'
import type { ConnectionRegistry } from '../../transport/connectionRegistry'
import type { Dispatcher } from '../../transport/dispatcher'
import { publishBoardFrames } from '../../transport/frames/board'
import { NO_LEDGER_TOTALS } from '../../transport/mappers/wire'
import { registerMineRemoval, registerMines } from '../../transport/methods/mines'
import { registerMinesSection } from '../../transport/snapshot/sections/mines'
import type { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { errorCode } from '../boot'

/** The events the mines wiring routes or projects: one Host bus carries them all (16 §2.3). */
export type MinesRouteEvent = MinesEvent | CrewEvent | ObservationEvent

/** The Host bus as the mines wiring uses it: mines publishes; crew and observation are read. */
export type MinesWiringBus = MinesDeps['bus'] &
  Pick<DomainEventBus<MinesEvent>, 'subscribe'> &
  Pick<DomainEventBus<CrewEvent>, 'subscribe'> &
  Pick<DomainEventBus<ObservationEvent>, 'subscribe'>

/** Crew's half of the mines wiring, through crew's public door (05 §1.3 mines → crew). */
export interface MinesCrewBinding {
  /** The mine of a dwarf (`CrewQueries.get`), null for one crew does not know. */
  mineOf(dwarfId: DwarfId): MineId | null
  /** `Crew.ends` over the Host's `SessionTerminator`, for Remove mine. */
  ends: CrewEnds
  /** The dwarfs the board frames read. */
  queries: Pick<CrewQueries, 'get'>
}

/** No crew module is constructed yet (later: ISSUE-094): no dwarf exists. */
export const noCrewYet: MinesCrewBinding = {
  mineOf: () => null,
  ends: { endAllIn: () => Promise.resolve({ ended: [], failed: [] }) },
  queries: { get: () => null }
}

/**
 * The settings the Host's mines run on: the documented defaults (`AppConfig.mineMeasureDelayMs`,
 * 05 §3.1 `MINE_FOLDER_CHECK_MS`, 06 §4.1 `TierThresholds`). The Host does not read the layered
 * configuration for them yet (environment, then the userData file, then these; later: a Host
 * settings reader like featureFlagReader.ts).
 */
export const DEFAULT_MINES_SETTINGS: Readonly<
  Pick<MinesWiringDeps, 'automaticWalkDelayMs' | 'folderCheckMs' | 'thresholds'>
> = Object.freeze({
  automaticWalkDelayMs: defaultConfig().mineMeasureDelayMs,
  folderCheckMs: MINE_FOLDER_CHECK_MS,
  thresholds: DEFAULT_TIER_THRESHOLDS
})

export interface MinesServeDeps {
  /** The Host dispatcher (hostDispatcher.ts), where the module's methods join. */
  dispatcher: Dispatcher
  /** The snapshot sections, where the `mines` section joins. */
  sections: SectionRegistry
  /** Where the board frames go. */
  connections: ConnectionRegistry
}

export interface MinesWiringDeps {
  /** The Host's one writer (09 §8.1), opened by boot step 2. */
  db: SqliteDatabase
  /** Its transaction runner, also the bus's transaction scope (16 §2.2). */
  transactions: TransactionRunner & TransactionScope
  /** The Host's one event bus (16 §2.3). */
  bus: MinesWiringBus
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  /** Read only (`MinesDeps.fs`). */
  fs: Pick<FileSystem, 'stat' | 'readTextHead' | 'listDirWithSizes'>
  hostEpoch: HostEpoch
  log: DiagnosticsLog
  /** The map's spawn sites (`MinesDeps.mapSites`). */
  mapSites: readonly MapSite[]
  /** `Math.random` in production (`MinesDeps.random`). */
  random: () => number
  /** `FsSourceWeightScanner` in production. */
  scanner: SourceWeightScanner
  /** Read once at Host start (06 §4.1). */
  thresholds: TierThresholds
  /** `AppConfig.mineMeasureDelayMs`. */
  automaticWalkDelayMs: number
  /** `MINE_FOLDER_CHECK_MS` (05 §3.1). */
  folderCheckMs: number
  /** `noCrewYet` until ISSUE-094. */
  crew: MinesCrewBinding
}

export interface WiredMines {
  /** The one instance the served members forward to. */
  mines: Mines
  walks: MineWalks
  folderChecks: FolderCheckSchedule
  /** After boot step 7: the boot walks (S3.25) and the folder-check schedule. */
  start(): void
  /** Resolves once every walk, folder check and routed check has answered (tests; drain). */
  idle(): Promise<void>
}

export interface ServedMines {
  /** Boot step 4: constructs and wires the module the served members forward to. */
  wire(deps: MinesWiringDeps): WiredMines
}

/** The members the served methods and section forward to. */
type ServedMembers = {
  queries: Pick<MinesQueries, 'list' | 'get' | 'resolveFileInMine'>
  commands: Pick<MinesCommands, 'declare' | 'adoptMainProject' | 'remove'>
}

/** Serves the module's seam-B members before it exists; `wire` constructs it at boot step 4. */
export function serveMines(serve: MinesServeDeps): ServedMines {
  let wired: ServedMembers | undefined
  const current = (): ServedMembers => {
    if (wired === undefined) throw new HostInvariantError('mines are served from boot step 4 on')
    return wired
  }
  const served: ServedMembers = {
    queries: {
      list: (query) => current().queries.list(query),
      get: (mineId) => current().queries.get(mineId),
      resolveFileInMine: (mineId, target) => current().queries.resolveFileInMine(mineId, target)
    },
    commands: {
      declare: (path) => current().commands.declare(path),
      adoptMainProject: (path) => current().commands.adoptMainProject(path),
      remove: (mineId, requestId) => current().commands.remove(mineId, requestId)
    }
  }
  registerMines(serve.dispatcher, { mines: served.queries, commands: served.commands })
  registerMineRemoval(serve.dispatcher, served.commands)
  // The ledger's totals join with the ledger (later: ISSUE-096).
  registerMinesSection(serve.sections, { mines: served.queries, ledger: NO_LEDGER_TOTALS })
  return {
    wire: (deps) => {
      if (wired !== undefined) throw new HostInvariantError('mines are wired once')
      const result = wireMines(deps, serve.connections)
      wired = {
        queries: result.mines.queries,
        commands: { ...result.mines.commands, ...result.removal }
      }
      return result
    }
  }
}

function wireMines(
  deps: MinesWiringDeps,
  connections: ConnectionRegistry
): WiredMines & { removal: Pick<MinesCommands, 'remove'> } {
  const { bus, log } = deps
  // `remeasure` is called only by commands, after construction; the walks are built from the
  // instance they walk, so this binding closes the loop.
  const bound: { walks?: MineWalks } = {}
  const mines = createMines({
    ...deps,
    remeasure: (mineId) => {
      if (bound.walks === undefined) {
        throw new HostInvariantError('a walk is due before the walks exist')
      }
      bound.walks.walkDue(mineId)
    }
  })
  const measurement = mines.measurement(deps)
  bound.walks = measurement
  const removal = mines.removal({
    crew: deps.crew.ends,
    abortWalk: (mineId) => measurement.abort(mineId)
  })
  const folderChecks = mines.folderCheckSchedule({
    scheduler: deps.scheduler,
    intervalMs: deps.folderCheckMs
  })
  publishBoardFrames({
    events: { mines: bus, crew: bus, observation: bus },
    mines: mines.queries,
    crew: deps.crew.queries,
    ledger: NO_LEDGER_TOTALS,
    frames: connections
  })

  /** The checks the error route started that have not answered yet. */
  const routed = new Set<Promise<unknown>>()
  bus.subscribe('ProviderErrorObserved', ({ payload }) => {
    if (payload.dwarfId === undefined) return
    const mineId = deps.crew.mineOf(payload.dwarfId)
    if (mineId === null) return
    const check = mines.commands
      .checkFolder(mineId)
      .catch((error: unknown) =>
        log.record({
          level: 'error',
          event: 'uncaught',
          subsystem: 'host',
          errCode: errorCode(error)
        })
      )
      .finally(() => routed.delete(check))
    routed.add(check)
  })

  return {
    mines,
    walks: measurement,
    folderChecks,
    removal,
    start: () => {
      measurement.resumeAtBoot()
      folderChecks.start()
    },
    // A routed or scheduled check that finds a folder again queues a walk (S3.13, S3.14), so the
    // longest chain is check → walk: two rounds settle it, a third confirms nothing new started.
    idle: async () => {
      for (let round = 0; round < 3; round += 1) {
        await Promise.all([measurement.idle(), folderChecks.idle(), ...routed])
      }
    }
  }
}
