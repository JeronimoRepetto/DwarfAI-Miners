// The `MinesQueries` driving port (05 §3.1; 16 §4.1): read models over `MineRepository`.
// Read-only: no transaction, no event.
//
// - `list` answers the Mines page browse (`MineQuery`): the repository's page, each mine as a
//   `MineSummary` with its present-dwarf count. Removed mines are never listed (09 §4.11), so a
//   listed summary's `removed` is false.
// - `get` and `folderOf` read one mine on the board: a removed or unknown mine reads as none.
// - `resolveFileInMine` is `resolveFile.ts`'s (ISSUE-066): it reads the disk, so the module index composes it beside this read model.
import type { FolderPath, Instant, MineId, Result } from '../../../kernel/domain/values'
import { scoreOf, type Mine, type MineName, type MineScore } from '../domain/mine'
import type { MinePath } from '../domain/minePath'
import type { Tier, TierThresholds } from '../domain/tier'
import type { MineQuery, MineRepository } from '../ports/mineRepository'

// verbatim: 05 §3.1 (16 §4.1) `MinesQueries`
export interface MinesQueries {
  list(query: MineQuery): MineSummary[]
  get(mineId: MineId): MineView | null
  resolveFileInMine(mineId: MineId, target: string): Result<FolderPath, 'escapes-mine' | 'missing'> // openMineFile.ts
  folderOf(mineId: MineId): FolderPath | null
}
// end verbatim

/** One row of the Mines page (14 §3.4 `MineSummaryWire` before the wire mapping). */
export interface MineSummary {
  mineId: MineId
  name: MineName
  path: MinePath
  tier: Tier | null
  lastUsedAt: Instant
  presentDwarfs: number
  removed: boolean
}

/**
 * One mine on the board with its present-dwarf count (the ledger totals are ledger's, ISSUE-082) and, once measured,
 * its score toward the next tier (AMENDMENT-26, owner-approved 2026-10-23; 06 §0.2 view note): derived from the stored
 * weight and the Host's active thresholds, absent while never measured or `unrecorded`.
 */
export type MineView = Mine & { readonly presentDwarfs: number; readonly score?: MineScore }

/**
 * Interim (until ISSUE-094 wires crew's `CrewQueries` into mines): how many present dwarfs each
 * mine has, read by the repository adapter's join on `dwarfs` (a dwarf is present until it
 * departs). The frozen `MineRepository` (16 §4.1) has no such read, so it sits beside it,
 * implemented by the same adapter and its double, and is replaced by the crew edge in ISSUE-094.
 */
export interface PresentDwarfCounts {
  /** Present dwarfs per mine; a mine with none may be absent from the map. */
  presentDwarfsIn(mineIds: readonly MineId[]): ReadonlyMap<MineId, number>
}

export interface MineReadModelDeps {
  repository: MineRepository
  /** Interim, until ISSUE-094. */
  presentDwarfs: PresentDwarfCounts
  /** The tier thresholds read once at Host start (06 §4.1), the score's next-tier floor (AMENDMENT-26). */
  thresholds: TierThresholds
}

/** `MinesQueries` without `resolveFileInMine`, which `resolveFile.ts` serves (ISSUE-066). */
export class MineReadModel implements Omit<MinesQueries, 'resolveFileInMine'> {
  constructor(private readonly deps: MineReadModelDeps) {}

  list(query: MineQuery): MineSummary[] {
    const mines = this.deps.repository.query(query)
    const present = this.deps.presentDwarfs.presentDwarfsIn(mines.map((mine) => mine.id))
    return mines.map((mine) => ({
      mineId: mine.id,
      name: mine.name,
      path: mine.path,
      tier: mine.tier,
      lastUsedAt: mine.lastUsedAt,
      presentDwarfs: present.get(mine.id) ?? 0,
      removed: mine.state === 'removed'
    }))
  }

  get(mineId: MineId): MineView | null {
    const mine = this.onBoard(mineId)
    if (mine === null) return null
    const score = scoreOf(mine, this.deps.thresholds)
    return {
      ...mine,
      presentDwarfs: this.deps.presentDwarfs.presentDwarfsIn([mine.id]).get(mine.id) ?? 0,
      ...(score === null ? {} : { score })
    }
  }

  folderOf(mineId: MineId): FolderPath | null {
    return (this.onBoard(mineId)?.path ?? null) as FolderPath | null
  }

  private onBoard(mineId: MineId): Mine | null {
    const mine = this.deps.repository.byId(mineId)
    return mine === null || mine.state === 'removed' ? null : mine
  }
}
