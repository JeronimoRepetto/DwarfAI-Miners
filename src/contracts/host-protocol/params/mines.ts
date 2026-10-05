// Seam-B params and results of the mines rows (14 §3.4, §1.2): B-M16 `mines.declare`, B-M17
// `mines.adoptMainProject`, B-M19 `mines.list` (relayed by A-34, §8 I-10) and B-M20
// `mines.resolveFile`.
import { z } from 'zod'
import {
  dwarfIdSchema,
  folderPathSchema,
  instantSchema,
  mineIdSchema,
  tierSchema,
  type FolderPath,
  type Instant,
  type MineId,
  type Tier
} from '../../wire'
import { outcomeSchema, type Outcome } from '../errors'
import { requestIdSchema } from '../requestId'
import { WIRE_PATH_MAX_CHARS, wirePathSchema } from './bounds'

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): mines, B-M16, B-M17, B-M20
export type DeclareMineResult = Outcome<
  { mineId: MineId } | { worktreeOf: MineId },
  'not-a-folder' | 'invalid-path'
> // = 05 declare; main keeps the path it picked for A-31
export type AdoptMainProjectResult = Outcome<{ mineId: MineId }, 'no-main-project'>
export type ResolveFileResult = Outcome<{ path: FolderPath }, 'escapes-mine' | 'missing'>

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

/**
 * A folder path on the wire, at most `WIRE_PATH_MAX_CHARS`. Whether it names a folder is the
 * Host's re-validation (14 §1.10, ADR-019 item 9: `not-a-folder` / `invalid-path`), not the wire's.
 */
const wireFolderPathSchema = z.custom<FolderPath>(
  (value) => typeof value === 'string' && value.length <= WIRE_PATH_MAX_CHARS,
  { message: 'expected a folder path string' }
)

/** B-M16 params, strict: the folder UI main's picker produced (14 §1.10). */
export const declareMineParamsSchema = z
  .object({ path: wireFolderPathSchema, requestId: requestIdSchema })
  .strict()

export const declareMineResultSchema = outcomeSchema(
  z.union([
    z.object({ mineId: mineIdSchema }).strict(),
    z.object({ worktreeOf: mineIdSchema }).strict()
  ]),
  z.enum(['not-a-folder', 'invalid-path'])
)

/** B-M17 params, strict: the worktree path UI main remembered for A-31. */
export const adoptMainProjectParamsSchema = z
  .object({ worktreePath: wireFolderPathSchema, requestId: requestIdSchema })
  .strict()

export const adoptMainProjectResultSchema = outcomeSchema(
  z.object({ mineId: mineIdSchema }).strict(),
  z.literal('no-main-project')
)

/**
 * B-M20 params, strict: a mine id and a target relative to the mine (14 §1.10). Package gap (14 is
 * silent): an empty target names nothing, so it is refused, as today's `openMinePath` does.
 * `dwarfId` is accepted and has no counterpart in the frozen `resolveFileInMine` (16 §4.1).
 */
export const resolveFileParamsSchema = z
  .object({
    mineId: mineIdSchema,
    dwarfId: dwarfIdSchema.optional(),
    target: wirePathSchema.min(1)
  })
  .strict()

export const resolveFileResultSchema = outcomeSchema(
  z.object({ path: folderPathSchema }).strict(),
  z.enum(['escapes-mine', 'missing'])
)
