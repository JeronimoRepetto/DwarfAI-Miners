// The mines module (05 §3.1): a person's projects as mines. Its domain (ISSUE-062): the exact-folder
// identity (`MinePath`, ADR-030 item 1), the worktree fold, the tier thresholds and the `Mine`
// aggregate with machine 3. ISSUE-063: the mines stored in the Host database (`MineRepository`,
// the only writer of `mines`) and `MinesQueries` for the Mines page browse (B-M19). ISSUE-066:
// "Add a mine" and the worktree dialog (`declare`, `adoptMainProject`), the mine of a session's
// cwd (`resolveForSession`) and `resolveFileInMine`, every path re-validated on the real disk
// (18 C-17). ISSUE-085: `checkFolder`, run by `resolveForSession` for a known mine, and the
// folder-check schedule that `host/wiring` starts. ISSUE-080: Remove mine (`remove`) over crew's
// `endAllIn` and the running walk (`Mines.removal`). ISSUE-065: the scoring walks
// (`Mines.measurement`). ISSUE-093 wires them into the Host (host/wiring/routes/mines.ts).
import type { HostEpoch, MineId } from '../../kernel/domain/values'
import type { CrewEnds } from '../crew'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { FileSystem } from '../../kernel/ports/fileSystem'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { createHostGitRepoInspector } from './adapters/FsGitRepoInspector'
import { MinesResetStep } from './adapters/sqlite/MinesResetStep'
import { NodePathProbe } from './adapters/pathValidation'
import { SqliteMineRepository } from './adapters/SqliteMineRepository'
import { hostVolumeRules } from './adapters/volumeCase'
import { createCheckFolder } from './application/checkFolder'
import { createDeclareCommands, type MinesCommands } from './application/declare'
import type { MineRemovalEvent } from './application/events'
import { FolderCheckSchedule } from './application/folderCheckSchedule'
import { MineMeasurement } from './application/measure'
import { MineReadModel, type MinesQueries } from './application/mineQueries'
import { resolveFileInMine } from './application/resolveFile'
import { createRemove } from './application/remove'
import { createResolveForSession } from './application/resolveForSession'
import type { MinesEvent as MineLifecycleEvent } from './domain/events'
import type { MapSite } from './domain/mine'
import type { TierThresholds } from './domain/tier'
import type { SourceWeightScanner } from './ports/sourceWeightScanner'

export type { MinesCommands } from './application/declare'
export type { MinesQueries, MineSummary, MineView } from './application/mineQueries'
export { MINE_FOLDER_CHECK_MS, type FolderCheckSchedule } from './application/folderCheckSchedule'
export type {
  MineBecameEnterable,
  MineBecameUnenterable,
  MineCreated,
  MineMeasured,
  MineMeasurementStarted,
  MineReattached
} from './domain/events'
export type {
  MineRemovalEvent,
  MineRemovalFailed,
  MineRemoved,
  MinesEvent
} from './application/events'
export type { FolderUnenterableReason } from './domain/folderCheck'
export type { MapMarker, MapSite, Mine, MineName, MineState, MineTransitionId } from './domain/mine'
export type { MinePath, PathStyle } from './domain/minePath'
export { DEFAULT_TIER_THRESHOLDS, type Tier, type TierThresholds } from './domain/tier'
export type { MineQuery } from './ports/mineRepository'
export type { SourceWeightScanner } from './ports/sourceWeightScanner'

export interface MinesDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** Its transaction runner (16 §2.2): `MineRepository.save` runs inside the caller's tx. */
  transactions: TransactionRunner & TransactionScope
  /** The map's spawn sites, in image percent (06 §4.1), that a new mine's site is picked from. */
  mapSites: readonly MapSite[]
  /** A fraction in [0, 1) for the map-site pick; production passes `Math.random`. */
  random: () => number
  /**
   * Read only: the git inspector reads `.git` files through it (ADR-030), and `checkFolder` stats
   * a mine's folder, listing it only when the stat cannot tell why it failed.
   */
  fs: Pick<FileSystem, 'stat' | 'readTextHead' | 'listDirWithSizes'>
  clock: Clock
  ids: IdGenerator
  /** The Host bus: the lifecycle events of `domain/events.ts` and Remove mine's (`MinesEvent`). */
  bus: DomainEventBus<MineLifecycleEvent> & Pick<DomainEventBus<MineRemovalEvent>, 'publish'>
  hostEpoch: HostEpoch
  /**
   * The walk a created, reattached or found-again mine is due: `host/wiring` binds it to
   * `Mines.measurement(…).walkDue` of this instance.
   */
  remeasure(mineId: MineId): void
}

export interface Mines {
  queries: MinesQueries
  /** The commands built so far (ISSUE-066, ISSUE-085). */
  commands: Pick<
    MinesCommands,
    'declare' | 'adoptMainProject' | 'resolveForSession' | 'checkFolder'
  >
  /**
   * The folder check of every mine with a present dwarf, every `intervalMs` (05 §3.1; 07 S3.12
   * trigger (c)), over this instance's `checkFolder`; `host/wiring` starts it after boot with the
   * kernel `Scheduler` and `MINE_FOLDER_CHECK_MS`.
   */
  folderCheckSchedule(deps: { scheduler: Scheduler; intervalMs: number }): FolderCheckSchedule
  /**
   * `MinesCommands.remove` (ISSUE-080) over crew's `endAllIn` (the mines → crew edge, 05 §1.3) and
   * the abort of the mine's running walk (S3.15, `MinesCommands.remeasure`'s walk): `host/wiring`
   * passes both when it composes crew and the measurement.
   */
  removal(deps: { crew: CrewEnds; abortWalk(mineId: MineId): void }): Pick<MinesCommands, 'remove'>
  /**
   * The scoring walks of this instance's mines (`MinesCommands.remeasure`, ISSUE-065; 07 S3.04,
   * S3.08…S3.11, S3.15, S3.25), over the kernel `Scheduler` and the `SourceWeightScanner` the
   * composition root builds. `host/wiring` binds `MinesDeps.remeasure` to its `walkDue`.
   */
  measurement(deps: MineWalksDeps): MineWalks
}

export interface MineWalksDeps {
  scanner: SourceWeightScanner
  scheduler: Scheduler
  /** Read once at Host start (06 §4.1). */
  thresholds: TierThresholds
  /** How long after its creation an `unrecorded` mine is walked (`AppConfig.mineMeasureDelayMs`). */
  automaticWalkDelayMs: number
}

export interface MineWalks {
  /**
   * The walk a created, reattached or found-again mine is due: an `unrecorded` one waits for the
   * automatic walk (S3.01, S3.08, S3.19), any other is walked now (S3.04, S3.10, S3.13, S3.14,
   * S3.20, S3.21). The binding of `MinesDeps.remeasure`.
   */
  walkDue(mineId: MineId): void
  /** `MinesCommands.remeasure`. */
  remeasure(mineId: MineId): void
  /** Removal (S3.15): the mine's running walk is aborted and a pending one dropped. */
  abort(mineId: MineId): void
  /** Reset metrics: every walk aborted, every pending one dropped. */
  abortAll(): void
  /** Host boot (S3.25): measuring mines walked from scratch, unrecorded ones scheduled. */
  resumeAtBoot(): void
  /** Resolves once every started walk has been answered (tests; the Host's drain). */
  idle(): Promise<void>
}

/** The module over the Host database and the real disk, with the Host OS's path rules. */
export function createMines(deps: MinesDeps): Mines {
  const repository = new SqliteMineRepository({
    db: deps.db,
    scope: deps.transactions,
    mapSites: deps.mapSites,
    random: deps.random
  })
  const style = hostVolumeRules(deps.clock).style
  const paths = new NodePathProbe()
  // Interim: the present-dwarf counts come from the repository's join until ISSUE-094.
  const readModel = new MineReadModel({ repository, presentDwarfs: repository })
  const queries: MinesQueries = {
    list: (query) => readModel.list(query),
    get: (mineId) => readModel.get(mineId),
    folderOf: (mineId) => readModel.folderOf(mineId),
    resolveFileInMine: (mineId, target) =>
      resolveFileInMine({ repository, paths, style }, mineId, target)
  }
  const commandDeps = {
    repository,
    transactions: deps.transactions,
    resolver: createHostGitRepoInspector({ fs: deps.fs, clock: deps.clock }),
    paths,
    ids: deps.ids,
    clock: deps.clock,
    bus: deps.bus,
    hostEpoch: deps.hostEpoch,
    style,
    remeasure: (mineId: MineId) => deps.remeasure(mineId)
  }
  const { checkFolder } = createCheckFolder({ ...commandDeps, fs: deps.fs })
  // Interim, until ISSUE-094 gives mines crew's present dwarfs: the repository's join.
  const minesWithPresentDwarfs = (): MineId[] => {
    const ids = repository.query({ sortBy: 'name', direction: 'asc' }).map((mine) => mine.id)
    const counts = repository.presentDwarfsIn(ids)
    return ids.filter((mineId) => (counts.get(mineId) ?? 0) > 0)
  }
  return {
    queries,
    commands: {
      ...createDeclareCommands(commandDeps),
      ...createResolveForSession({ ...commandDeps, checkFolder }),
      checkFolder
    },
    folderCheckSchedule: ({ scheduler, intervalMs }) =>
      new FolderCheckSchedule({ scheduler, intervalMs, minesWithPresentDwarfs, checkFolder }),
    removal: ({ crew, abortWalk }) => createRemove({ ...commandDeps, crew, abortWalk }),
    measurement: (walkDeps) => {
      const walks = new MineMeasurement({
        repository,
        transactions: deps.transactions,
        scanner: walkDeps.scanner,
        scheduler: walkDeps.scheduler,
        clock: deps.clock,
        bus: deps.bus,
        ids: deps.ids,
        hostEpoch: deps.hostEpoch,
        thresholds: walkDeps.thresholds,
        automaticWalkDelayMs: walkDeps.automaticWalkDelayMs
      })
      return {
        walkDue: (mineId) =>
          repository.byId(mineId)?.state === 'unrecorded'
            ? walks.mineCreated(mineId)
            : walks.remeasure(mineId),
        remeasure: (mineId) => walks.remeasure(mineId),
        abort: (mineId) => walks.abort(mineId),
        abortAll: () => walks.abortAll(),
        resumeAtBoot: () => walks.resumeAtBoot(),
        idle: () => walks.idle()
      }
    }
  }
}

/**
 * The mines step of the Reset-metrics saga (ADR-023 items 1, 3; 09 §7.2): the shape of the
 * preferences module's `ResetDbStep` (16 §4.12), stated here so mines imports nothing from
 * preferences (05 §1.3, R4). `reset` joins the saga's one `db` transaction; the walk of each mine
 * it recreated is queued by `walkRecreatedMines`, which `host/wiring` calls once that transaction
 * committed (on `MetricsResetStarted`, 16 §2.3), never inside it.
 */
export interface MinesResetDbStep {
  readonly name: string
  reset(tx: TransactionRunner): void
  /** After the commit: hands every mine the last `reset` recreated to `remeasure`, once. */
  walkRecreatedMines(): void
}

/** `name: 'mines'`; registered with the saga by host/wiring/resetParticipants.ts. */
export function createMinesResetStep(deps: {
  db: SqliteDatabase
  scope: TransactionScope
  clock: Clock
  /** The map's spawn sites a recreated mine's site is re-picked from (as `MinesDeps.mapSites`). */
  mapSites: readonly MapSite[]
  /** A fraction in [0, 1) for the pick; production passes `Math.random`. */
  random: () => number
  /** A recreated mine's walk (as `MinesDeps.remeasure`). */
  remeasure(mineId: MineId): void
}): MinesResetDbStep {
  return new MinesResetStep(deps)
}
