// Seam-B params and results of `mines.list` (B-M19) that A-34 relays (14 §3.4, §1.2, §8 I-10).
import { z } from 'zod'
import {
  folderPathSchema,
  instantSchema,
  mineIdSchema,
  tierSchema,
  type FolderPath,
  type Instant,
  type MineId,
  type Tier
} from '../../wire'

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): mines, B-M19
export interface MineListParams {
  // 05 MineQuery; field names kept from today's ProjectQuery
  tier?: Tier
  sortBy: 'name' | 'lastUsed' | 'tier' | 'ore'
  direction: 'asc' | 'desc'
  nameContains?: string
  limit?: number
  offset?: number
}
export interface MineListResult {
  mines: MineSummaryWire[]
  total: number
}
export interface MineSummaryWire {
  mineId: MineId
  name: string
  path: FolderPath
  tier: Tier | null
  lastUsedAt: Instant
  presentDwarfs: number
  removed: boolean
}

/**
 * Package gap (14 is silent): the largest page one `mines.list` answers. Today's browse caps a
 * page at 500 rows (`PROJECT_QUERY_MAX_LIMIT`, `projectQuery.ts`), so a page is a page and not a
 * table dump.
 */
export const MINE_LIST_MAX_LIMIT = 500

/** Package gap (14 is silent): a search term; a folder name is at most 255 characters. */
export const MINE_SEARCH_MAX_CHARS = 256

/**
 * B-M19 params, strict (ADR-019): `limit` a whole number from 1 to `MINE_LIST_MAX_LIMIT`, `offset`
 * a whole number from 0; both absent = every listed mine from the first.
 */
export const mineListParamsSchema = z
  .object({
    tier: tierSchema.optional(),
    sortBy: z.enum(['name', 'lastUsed', 'tier', 'ore']),
    direction: z.enum(['asc', 'desc']),
    nameContains: z.string().max(MINE_SEARCH_MAX_CHARS).optional(),
    limit: z.number().int().min(1).max(MINE_LIST_MAX_LIMIT).optional(),
    offset: z.number().int().nonnegative().optional()
  })
  .strict()

export const mineSummaryWireSchema = z
  .object({
    mineId: mineIdSchema,
    name: z.string(),
    path: folderPathSchema,
    tier: tierSchema.nullable(),
    lastUsedAt: instantSchema,
    presentDwarfs: z.number().int().nonnegative(),
    removed: z.boolean()
  })
  .strict()

/** B-M19 result: one page of mines and how many mines the browse matches in all. */
export const mineListResultSchema = z
  .object({
    mines: z.array(mineSummaryWireSchema),
    total: z.number().int().nonnegative()
  })
  .strict()
