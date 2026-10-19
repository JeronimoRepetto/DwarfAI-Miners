// The mines module's step of the Reset-metrics saga (16 §4.12 `ResetDbStep`; ADR-023 items 1, 3,
// 4; 07 S3.23, S3.24; 09 §7.2 rows `mines`). It joins the saga's one `db` transaction (16 §2.2):
// called outside one it throws `HostInvariantError` and writes nothing.
//
// - A mine with no present dwarf (declared, discovered or removed) is deleted; its dwarfs, their
//   rows and its ledger go with it by cascade (S3.23, 09 §7.2 step (2)).
// - A mine with a present dwarf is recreated fresh at the same row and id (S3.24): `measuring`,
//   no tier, never measured, no weight, not removed or unenterable, `created_at = last_used_at =
//   now`, and its map site re-picked among the sites no other kept mine holds (`chooseMapSite`,
//   in id order so the pick is reproducible). Its dwarfs are not touched here: the session goes
//   on (INV-109).
// - The walk of each recreated mine is queued only after the commit (16 §2.3: a walk publishes):
//   `reset` records the mines, and `walkRecreatedMines`, which host/wiring calls once the saga's
//   `db` transaction committed, hands each to `remeasure` once.
//
// "Present" is the 09 `dwarfs_crew` predicate (`departed_at IS NULL`), part of the one SQL
// statement, as the attention step reads it. It satisfies `ResetDbStep` structurally: mines has
// no edge to `preferences` (05 §1.3, R4).
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { MineId } from '../../../../kernel/domain/values'
import type { Clock } from '../../../../kernel/ports/clock'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'
import { chooseMapSite } from '../../domain/mapSite'
import type { MapSite } from '../../domain/mine'

export interface MinesResetStepDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
  clock: Clock
  /** The map's spawn sites (`MinesDeps.mapSites`). */
  mapSites: readonly MapSite[]
  /** A fraction in [0, 1) for the map-site pick. */
  random: () => number
  /** A recreated mine's walk (`MinesDeps.remeasure`), called only after the commit. */
  remeasure(mineId: MineId): void
}

const DELETE_UNOCCUPIED = `DELETE FROM mines WHERE id NOT IN (
  SELECT mine_id FROM dwarfs WHERE departed_at IS NULL)`

const RECREATE = `UPDATE mines SET state = 'measuring', tier = NULL, source_weight_bytes = NULL,
  has_been_measured = 0, measured_at = NULL, unenterable_reason = NULL, removed_at = NULL,
  created_at = ?, last_used_at = ?, map_site_x_pct = NULL, map_site_y_pct = NULL`

const OCCUPIED_SITES = `SELECT map_site_x_pct, map_site_y_pct FROM mines
  WHERE map_site_x_pct IS NOT NULL`

export class MinesResetStep {
  readonly name = 'mines'
  private recreated: MineId[] = []

  constructor(private readonly deps: MinesResetStepDeps) {}

  reset(tx: TransactionRunner): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        "the mines ResetDbStep runs inside the saga's db transaction (16 §2.2)"
      )
    }
    this.recreated = tx.inTransaction(() => {
      const { db } = this.deps
      db.run(DELETE_UNOCCUPIED)
      // Every mine left has a present dwarf.
      const now = this.deps.clock.now()
      db.run(RECREATE, [now, now])
      const kept = db.all('SELECT id FROM mines ORDER BY id').map((row) => String(row['id']))
      for (const id of kept) this.repickSite(id)
      return kept as MineId[]
    })
  }

  walkRecreatedMines(): void {
    const mines = this.recreated
    this.recreated = []
    for (const mineId of mines) this.deps.remeasure(mineId)
  }

  private repickSite(mineId: string): void {
    const occupied = this.deps.db
      .all(OCCUPIED_SITES)
      .map((row) => ({ xPct: Number(row['map_site_x_pct']), yPct: Number(row['map_site_y_pct']) }))
    const site = chooseMapSite(this.deps.mapSites, occupied, this.deps.random)
    if (site === null) return
    this.deps.db.run('UPDATE mines SET map_site_x_pct = ?, map_site_y_pct = ? WHERE id = ?', [
      site.xPct,
      site.yPct,
      mineId
    ])
  }
}
