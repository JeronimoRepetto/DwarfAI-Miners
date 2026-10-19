// `SqliteMineRepository` (16 §4.1; 05 §3.1): the `Mine` aggregate over `mines` (09 §4.2), through
// the kernel `SqliteDatabase`, in bound SQL only (ADR-005). The one writer of that table.
//
// - `canonical_path` is UNIQUE across all mines, removed ones included (INV-02). `save` of a mine
//   whose path another mine holds is a code defect: it throws `HostInvariantError` and writes
//   nothing, and the table's UNIQUE key stays the backstop. A mine's path never changes.
// - `save` is an upsert by id inside the caller's transaction (16 §2.2); outside one it throws
//   `HostInvariantError`. Removal is soft (`state = 'removed'`, `removed_at`): `ledger_entries` and
//   `material_totals` are never written here (PO #4, INV-06, NFR-PERS-08).
// - `name_norm` is the name folded for search (D-13, `foldForSearch`), written with the name.
// - The map site (the `mapSite.ts` rules): a mine's first write that carries none is given a free
//   spawn site, never one another mine holds (removed ones keep theirs); a later write that
//   carries none keeps the stored site.
// - `query` builds its WHERE / ORDER BY / LIMIT from closed tables and binds every value the
//   caller gave (`projectQuery.ts` rules): the search term is folded, its LIKE wildcards and the
//   escape character escaped in one pass, and every order ends on the id, so paging is total.
//
// Interim (`PresentDwarfCounts`, until ISSUE-094): present dwarfs per mine, read from `dwarfs`
// (present = not departed).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { FolderPath, MineId } from '../../../kernel/domain/values'
import type { SqliteDatabase, SqliteParam, SqliteRow } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { PresentDwarfCounts } from '../application/mineQueries'
import { chooseMapSite } from '../domain/mapSite'
import type { MapSite, Mine, MineName, MineState } from '../domain/mine'
import type { MinePath } from '../domain/minePath'
import { foldForSearch, searchTermOf } from '../domain/mineSearch'
import type { Tier } from '../domain/tier'
import type { MineQuery, MineRepository } from '../ports/mineRepository'

export interface SqliteMineRepositoryDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
  /** The map's spawn sites a new mine's site is picked from (image percent, 06 §4.1). */
  mapSites: readonly MapSite[]
  /** A fraction in [0, 1); production passes `Math.random`. */
  random: () => number
}

const COLUMNS = `id, canonical_path, name, name_norm, state, tier, source_weight_bytes,
  has_been_measured, measured_at, unenterable_reason, removed_at, created_at, last_used_at,
  map_site_x_pct, map_site_y_pct`

const SELECT = `SELECT ${COLUMNS} FROM mines`

// The map site is COALESCEd from the stored row first: once picked, a site stays.
const UPSERT = `INSERT INTO mines (${COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    name = excluded.name,
    name_norm = excluded.name_norm,
    state = excluded.state,
    tier = excluded.tier,
    source_weight_bytes = excluded.source_weight_bytes,
    has_been_measured = excluded.has_been_measured,
    measured_at = excluded.measured_at,
    unenterable_reason = excluded.unenterable_reason,
    removed_at = excluded.removed_at,
    created_at = excluded.created_at,
    last_used_at = excluded.last_used_at,
    map_site_x_pct = COALESCE(excluded.map_site_x_pct, mines.map_site_x_pct),
    map_site_y_pct = COALESCE(excluded.map_site_y_pct, mines.map_site_y_pct)`

/** The character that turns off LIKE's wildcards (`projectQuery.ts`). */
const LIKE_ESCAPE = '\\'

/** `%`, `_` and the escape character itself, escaped in one pass so no escape is re-escaped. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `${LIKE_ESCAPE}${character}`)
}

const TIER_RANK_SQL = `CASE tier WHEN 'bronze' THEN 0 WHEN 'copper' THEN 1 WHEN 'silver' THEN 2
  WHEN 'gold' THEN 3 WHEN 'uranium' THEN 4 END`

/** The `ore` order: richest material first, each compared on its own (BR-15, INV-93). */
const ORE_MATERIALS = ['uranium', 'gold', 'silver', 'copper', 'bronze', 'coal'] as const

const oreKey = (material: (typeof ORE_MATERIALS)[number]): string =>
  `COALESCE((SELECT t.tokens FROM material_totals t WHERE t.mine_id = mines.id AND t.material = '${material}'), 0)`

/**
 * Each sort key's ORDER BY keys, from a closed table: SQL text is never built from a value the
 * caller gave. `{dir}` is the direction, resolved by a comparison below.
 */
const ORDERS: Readonly<Record<MineQuery['sortBy'], (dir: 'ASC' | 'DESC') => string>> = {
  name: (dir) => `name_norm ${dir}, name ${dir}`,
  lastUsed: (dir) => `last_used_at ${dir}`,
  // A never-measured mine ranks after every measured one, in both directions (US-MINES-003.AC03).
  tier: (dir) => `(tier IS NULL) ASC, ${TIER_RANK_SQL} ${dir}, source_weight_bytes ${dir}`,
  ore: (dir) => ORE_MATERIALS.map((material) => `${oreKey(material)} ${dir}`).join(', ')
}

export class SqliteMineRepository implements MineRepository, PresentDwarfCounts {
  constructor(private readonly deps: SqliteMineRepositoryDeps) {}

  byPath(path: FolderPath): Mine | null {
    return this.one(`${SELECT} WHERE canonical_path = ?`, [path])
  }

  byId(id: MineId): Mine | null {
    return this.one(`${SELECT} WHERE id = ?`, [id])
  }

  save(mine: Mine): void {
    const { db, scope } = this.deps
    if (!scope.isInTransaction()) {
      throw new HostInvariantError(
        'MineRepository.save runs inside the caller transaction (16 §2.2)'
      )
    }
    const holder = db.all('SELECT id FROM mines WHERE canonical_path = ?', [mine.path])[0]
    if (holder !== undefined && holder['id'] !== mine.id) {
      throw new HostInvariantError('another mine holds this canonical path (INV-02)')
    }
    const stored = db.all('SELECT canonical_path FROM mines WHERE id = ?', [mine.id])[0]
    if (stored !== undefined && stored['canonical_path'] !== mine.path) {
      throw new HostInvariantError("a mine's canonical path never changes (INV-02)")
    }
    const site = mine.mapSite ?? (stored === undefined ? this.freeSite() : null)
    db.run(UPSERT, toParams(mine, site))
  }

  query(q: MineQuery): Mine[] {
    const conditions = ['removed_at IS NULL'] // 09 §4.11 `mines_last_used`: removed excluded
    const params: SqliteParam[] = []
    if (q.tier !== undefined) {
      conditions.push('tier = ?')
      params.push(q.tier)
    }
    const term = searchTermOf(q.nameContains)
    if (term !== null) {
      conditions.push(`name_norm LIKE ? ESCAPE '${LIKE_ESCAPE}'`)
      params.push(`%${escapeLike(term)}%`)
    }
    const direction = q.direction === 'asc' ? 'ASC' : 'DESC'
    const order = ORDERS[q.sortBy](direction)
    // SQLite reads a negative LIMIT as "no limit".
    params.push(q.limit ?? -1, q.offset ?? 0)
    return this.deps.db
      .all(
        `${SELECT} WHERE ${conditions.join(' AND ')} ORDER BY ${order}, id ASC LIMIT ? OFFSET ?`,
        params
      )
      .map(fromRow)
  }

  presentDwarfsIn(mineIds: readonly MineId[]): ReadonlyMap<MineId, number> {
    const counts = new Map<MineId, number>()
    if (mineIds.length === 0) return counts
    const placeholders = mineIds.map(() => '?').join(', ')
    const rows = this.deps.db.all(
      `SELECT mine_id, COUNT(*) AS present FROM dwarfs
        WHERE departed_at IS NULL AND mine_id IN (${placeholders}) GROUP BY mine_id`,
      mineIds
    )
    for (const row of rows) counts.set(String(row['mine_id']) as MineId, Number(row['present']))
    return counts
  }

  private freeSite(): MapSite | null {
    const occupied = this.deps.db
      .all('SELECT map_site_x_pct, map_site_y_pct FROM mines WHERE map_site_x_pct IS NOT NULL', [])
      .map((row) => ({ xPct: Number(row['map_site_x_pct']), yPct: Number(row['map_site_y_pct']) }))
    return chooseMapSite(this.deps.mapSites, occupied, this.deps.random)
  }

  private one(sql: string, params: readonly SqliteParam[]): Mine | null {
    const row = this.deps.db.all(sql, params)[0]
    return row === undefined ? null : fromRow(row)
  }
}

function toParams(mine: Mine, site: MapSite | null): SqliteParam[] {
  return [
    mine.id,
    mine.path,
    mine.name,
    foldForSearch(mine.name),
    mine.state,
    mine.tier,
    mine.sourceWeight?.bytes ?? null,
    mine.hasBeenMeasured ? 1 : 0,
    mine.measuredAt ?? null,
    mine.unenterableReason ?? null,
    mine.removedAt ?? null,
    mine.createdAt,
    mine.lastUsedAt,
    site?.xPct ?? null,
    site?.yPct ?? null
  ]
}

function fromRow(row: SqliteRow): Mine {
  const weight = numberOrNull(row['source_weight_bytes'])
  const measuredAt = numberOrNull(row['measured_at'])
  const unenterableReason = textOrNull(row['unenterable_reason'])
  const removedAt = numberOrNull(row['removed_at'])
  const x = numberOrNull(row['map_site_x_pct'])
  const y = numberOrNull(row['map_site_y_pct'])
  return {
    id: String(row['id']) as MineId,
    path: String(row['canonical_path']) as MinePath,
    name: String(row['name']) as MineName,
    state: row['state'] as MineState,
    tier: textOrNull(row['tier']) as Tier | null,
    sourceWeight: weight === null ? null : { bytes: weight },
    hasBeenMeasured: row['has_been_measured'] === 1,
    ...(measuredAt === null ? {} : { measuredAt }),
    ...(unenterableReason === null ? {} : { unenterableReason }),
    ...(removedAt === null ? {} : { removedAt }),
    createdAt: Number(row['created_at']),
    lastUsedAt: Number(row['last_used_at']),
    ...(x === null || y === null ? {} : { mapSite: { xPct: x, yPct: y } })
  }
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}
