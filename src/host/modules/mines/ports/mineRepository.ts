// Driven port of mines (05 §3.1; 16 §4.1 `MineRepository`): the aggregate store of `mines`
// (09 §4.2), and its only writer. Type-only (05 R2).
//
// - `byPath` looks a mine up by its canonical path (`MinePath`, INV-02), compared exactly: the
//   caller canonicalizes first (`canonicalMinePath`, ADR-030 item 1). Removed mines are found too,
//   so a rediscovery or a re-add reuses the same id (INV-07).
// - `save` is an upsert by id inside the caller's transaction (16 §2.2; outside one it throws). A
//   second mine with a path another mine already holds, removed ones included, is a code defect: it
//   throws and writes nothing (INV-02; the UNIQUE `canonical_path` stays the backstop). Removal is
//   soft: `state = 'removed'` with `removedAt`; the mine's ledger rows are never touched (PO #4,
//   INV-06, NFR-PERS-08). A mine's first write picks its map site when it carries none (the
//   `mapSite.ts` rules), and a later save that carries none keeps the stored one.
// - `query` answers the Mines page browse (`MineQuery`, 14 §3.4 `MineListParams`, the field names of
//   today's `ProjectQuery`, 14 §8 I-10) in bound SQL only (ADR-005; `projectQuery.ts`).
import type { FolderPath, MineId } from '../../../kernel/domain/values'
import type { Mine } from '../domain/mine'
import type { Tier } from '../domain/tier'

/**
 * One browse of the Mines page (05 `MineQuery` = 14 §3.4 `MineListParams`). Removed mines are never
 * listed (09 §4.11 `mines_last_used`). `tier` matches the stored (last measured) tier, so a
 * never-measured mine matches no tier (US-MINES-002.AC06, AC07). `nameContains` matches a substring
 * of the name, ignoring case and accents (US-MINES-001.AC05). Every order is total (ties by id):
 * `name`; `lastUsed`; `tier` by tier then source weight, a never-measured mine after every
 * measured one in both directions (US-MINES-003.AC03); `ore` by the mine's ledger totals, richest
 * material first, each material compared on its own (never summed, BR-15, INV-93). `limit` absent
 * = every row; `offset` absent = 0.
 */
export interface MineQuery {
  tier?: Tier
  sortBy: 'name' | 'lastUsed' | 'tier' | 'ore'
  direction: 'asc' | 'desc'
  nameContains?: string
  limit?: number
  offset?: number
}

export interface MineRepository {
  byPath(path: FolderPath): Mine | null
  byId(id: MineId): Mine | null
  /** Soft delete = state 'removed' + removedAt; ledger untouched (PO #4). */
  save(mine: Mine): void
  /** Bound SQL only (projectQuery.ts). */
  query(q: MineQuery): Mine[]
}
