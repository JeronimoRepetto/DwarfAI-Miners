// The mines module (05 §3.1): a person's projects as mines. Its domain (ISSUE-062): the exact-folder
// identity (`MinePath`, ADR-030 item 1), the worktree fold, the tier thresholds and the `Mine`
// aggregate with machine 3. ISSUE-063: the mines stored in the Host database (`MineRepository`,
// the only writer of `mines`) and `MinesQueries` for the Mines page browse (B-M19). ISSUE-066:
// "Add a mine" and the worktree dialog (`declare`, `adoptMainProject`), the mine of a session's
// cwd (`resolveForSession`) and `resolveFileInMine`, every path re-validated on the real disk
// (18 C-17). The other commands grow in later issues (later: ISSUE-065, ISSUE-080, ISSUE-085).
import type { HostEpoch, MineId } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { FileSystem } from '../../kernel/ports/fileSystem'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { createHostGitRepoInspector } from './adapters/FsGitRepoInspector'
import { NodePathProbe } from './adapters/pathValidation'
import { SqliteMineRepository } from './adapters/SqliteMineRepository'
import { hostVolumeRules } from './adapters/volumeCase'
import { createDeclareCommands, type MinesCommands } from './application/declare'
import { MineReadModel, type MinesQueries } from './application/mineQueries'
import { resolveFileInMine } from './application/resolveFile'
import { createResolveForSession } from './application/resolveForSession'
import type { MinesEvent } from './domain/events'
import type { MapSite } from './domain/mine'

export type { MinesCommands } from './application/declare'
export type { MinesQueries, MineSummary, MineView } from './application/mineQueries'
export type { MineCreated, MineReattached, MinesEvent } from './domain/events'
export type { MapMarker, MapSite, Mine, MineName, MineState, MineTransitionId } from './domain/mine'
export type { MinePath, PathStyle } from './domain/minePath'
export type { Tier } from './domain/tier'
export type { MineQuery } from './ports/mineRepository'

export interface MinesDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** Its transaction runner (16 §2.2): `MineRepository.save` runs inside the caller's tx. */
  transactions: TransactionRunner & TransactionScope
  /** The map's spawn sites, in image percent (06 §4.1), that a new mine's site is picked from. */
  mapSites: readonly MapSite[]
  /** A fraction in [0, 1) for the map-site pick; production passes `Math.random`. */
  random: () => number
  /** Read only: the git inspector reads `.git` files through it (ADR-030). */
  fs: Pick<FileSystem, 'stat' | 'readTextHead'>
  clock: Clock
  ids: IdGenerator
  bus: DomainEventBus<MinesEvent>
  hostEpoch: HostEpoch
  /** Interim, until ISSUE-065 composes `MinesCommands.remeasure` here: a new mine's walk. */
  remeasure(mineId: MineId): void
}

export interface Mines {
  queries: MinesQueries
  /** The commands built so far (ISSUE-066). */
  commands: Pick<MinesCommands, 'declare' | 'adoptMainProject' | 'resolveForSession'>
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
  return {
    queries,
    commands: { ...createDeclareCommands(commandDeps), ...createResolveForSession(commandDeps) }
  }
}
