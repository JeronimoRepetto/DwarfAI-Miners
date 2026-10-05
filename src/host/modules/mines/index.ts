// The mines module (05 §3.1): a person's projects as mines. Its domain (ISSUE-062): the exact-folder
// identity (`MinePath`, ADR-030 item 1), the worktree fold, the tier thresholds and the `Mine`
// aggregate with machine 3. ISSUE-063: the mines stored in the Host database (`MineRepository`,
// the only writer of `mines`) and `MinesQueries` for the Mines page browse (B-M19). ISSUE-066:
// `resolveFileInMine`, a mine-relative target resolved on the real disk (18 C-17). The commands
// grow in later issues (later: ISSUE-066, ISSUE-065, ISSUE-080).
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { NodePathProbe } from './adapters/pathValidation'
import { SqliteMineRepository } from './adapters/SqliteMineRepository'
import { MineReadModel, type MinesQueries } from './application/mineQueries'
import { resolveFileInMine } from './application/resolveFile'
import type { MapSite } from './domain/mine'
import type { PathStyle } from './domain/minePath'

export type { MinesQueries, MineSummary, MineView } from './application/mineQueries'
export type { MapMarker, MapSite, Mine, MineName, MineState, MineTransitionId } from './domain/mine'
export type { MinePath, PathStyle } from './domain/minePath'
export type { Tier } from './domain/tier'
export type { MineQuery } from './ports/mineRepository'

export interface MinesDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** Its transaction runner's probe (16 §2.2): `MineRepository.save` runs inside the caller's tx. */
  transactions: TransactionScope
  /** The map's spawn sites, in image percent (06 §4.1), that a new mine's site is picked from. */
  mapSites: readonly MapSite[]
  /** A fraction in [0, 1) for the map-site pick; production passes `Math.random`. */
  random: () => number
  /** The Host's path rules: `hostVolumeRules(clock).style` in production (`volumeCase.ts`). */
  style: PathStyle
}

export interface Mines {
  queries: MinesQueries
}

/** The module over the Host database and the real disk. */
export function createMines(deps: MinesDeps): Mines {
  const repository = new SqliteMineRepository({
    db: deps.db,
    scope: deps.transactions,
    mapSites: deps.mapSites,
    random: deps.random
  })
  // Interim: the present-dwarf counts come from the repository's join until ISSUE-094.
  const readModel = new MineReadModel({ repository, presentDwarfs: repository })
  const files = { repository, paths: new NodePathProbe(), style: deps.style }
  const queries: MinesQueries = {
    list: (query) => readModel.list(query),
    get: (mineId) => readModel.get(mineId),
    folderOf: (mineId) => readModel.folderOf(mineId),
    resolveFileInMine: (mineId, target) => resolveFileInMine(files, mineId, target)
  }
  return { queries }
}
