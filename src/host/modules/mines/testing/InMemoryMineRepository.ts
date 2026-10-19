// The MineRepository double (16 §4.1 `InMemoryMineRepository`, §2.8). Never imported by production
// code (R14). It lives in `testing/`, not `ports/fakes/`: it calls the domain's search fold and
// map-site rule and throws the kernel invariant error, and `ports/` is type-only (05 R2), as crew's
// `InMemoryDwarfRepository` does.
//
// The same rules as `SqliteMineRepository`, held equal by the shared `runMineRepositoryContract`:
// one mine per canonical path, removed ones included (INV-02); `save` only inside the caller's
// transaction (the injected `TransactionScope`); a mine's first save picks a free map site and a
// later save without one keeps the stored site; `query` filters, sorts and pages as `MineQuery`
// says. Ledger totals (for the `ore` order) and present dwarfs are seeded by the test (`credit`,
// `seatDwarf`); `save` never touches them. Rows are copied in and out, and a test's transaction
// rolls them back with `snapshot` / `restore`.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { FolderPath, MineId } from '../../../kernel/domain/values'
import type { PresentDwarfCounts } from '../application/mineQueries'
import { chooseMapSite } from '../domain/mapSite'
import type { MapSite, Mine } from '../domain/mine'
import { foldForSearch, searchTermOf } from '../domain/mineSearch'
import type { Tier } from '../domain/tier'
import type { MineQuery, MineRepository } from '../ports/mineRepository'
import type { LedgerMaterial } from './mineRepository.contract'

export interface InMemoryMineRepositoryDeps {
  scope: { isInTransaction(): boolean }
  /** The spawn sites a new mine's site is picked from. */
  mapSites: readonly MapSite[]
  /** A fraction in [0, 1). */
  random: () => number
}

/** The `ore` order: richest material first, each compared on its own (BR-15, INV-93). */
const ORE_ORDER: readonly LedgerMaterial[] = [
  'uranium',
  'gold',
  'silver',
  'copper',
  'bronze',
  'coal'
]

const TIER_RANK: Readonly<Record<Tier, number>> = {
  bronze: 0,
  copper: 1,
  silver: 2,
  gold: 3,
  uranium: 4
}

interface Snapshot {
  mines: readonly Mine[]
  ledger: readonly { mineId: MineId; material: LedgerMaterial; tokens: number }[]
  dwarfs: readonly { mineId: MineId; present: boolean }[]
}

export class InMemoryMineRepository implements MineRepository, PresentDwarfCounts {
  private mines: Mine[] = []
  private ledger: { mineId: MineId; material: LedgerMaterial; tokens: number }[] = []
  private dwarfs: { mineId: MineId; present: boolean }[] = []

  constructor(private readonly deps: InMemoryMineRepositoryDeps) {}

  byPath(path: FolderPath): Mine | null {
    return copyOf(this.mines.find((m) => m.path === (path as string)))
  }

  byId(id: MineId): Mine | null {
    return copyOf(this.mines.find((m) => m.id === id))
  }

  save(mine: Mine): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        'MineRepository.save runs inside the caller transaction (16 §2.2)'
      )
    }
    const holder = this.mines.find((m) => m.path === mine.path)
    if (holder !== undefined && holder.id !== mine.id) {
      throw new HostInvariantError('another mine holds this canonical path (INV-02)')
    }
    const at = this.mines.findIndex((m) => m.id === mine.id)
    const stored = at === -1 ? undefined : this.mines[at]
    if (stored !== undefined && stored.path !== mine.path) {
      throw new HostInvariantError("a mine's canonical path never changes (INV-02)")
    }
    const site =
      mine.mapSite ??
      stored?.mapSite ??
      (stored === undefined
        ? chooseMapSite(
            this.deps.mapSites,
            this.mines.flatMap((m) => (m.mapSite === undefined ? [] : [m.mapSite])),
            this.deps.random
          )
        : null) ??
      undefined
    const row: Mine =
      site === undefined
        ? structuredClone(mine)
        : { ...structuredClone(mine), mapSite: { ...site } }
    if (at === -1) this.mines.push(row)
    else this.mines[at] = row
  }

  query(q: MineQuery): Mine[] {
    const term = searchTermOf(q.nameContains)
    const listed = this.mines.filter(
      (m) =>
        m.state !== 'removed' &&
        (q.tier === undefined || m.tier === q.tier) &&
        (term === null || foldForSearch(m.name).includes(term))
    )
    const sign = q.direction === 'asc' ? 1 : -1
    const sorted = [...listed].sort((a, b) => this.compare(a, b, q.sortBy, sign) || byId(a, b))
    const offset = q.offset ?? 0
    const page =
      q.limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + q.limit)
    return page.map((m) => structuredClone(m))
  }

  presentDwarfsIn(mineIds: readonly MineId[]): ReadonlyMap<MineId, number> {
    const counts = new Map<MineId, number>()
    for (const dwarf of this.dwarfs) {
      if (dwarf.present && mineIds.includes(dwarf.mineId)) {
        counts.set(dwarf.mineId, (counts.get(dwarf.mineId) ?? 0) + 1)
      }
    }
    return counts
  }

  /** Test seeding: one ledger credit of a stored mine. */
  credit(mineId: MineId, material: LedgerMaterial, tokens: number): void {
    this.ledger.push({ mineId, material, tokens })
  }

  /** Test seeding: a dwarf in a mine, present or departed. */
  seatDwarf(mineId: MineId, present: boolean): void {
    this.dwarfs.push({ mineId, present })
  }

  ledgerRows(mineId: MineId): number {
    return this.ledger.filter((entry) => entry.mineId === mineId).length
  }

  snapshot(): Snapshot {
    return { mines: [...this.mines], ledger: [...this.ledger], dwarfs: [...this.dwarfs] }
  }

  restore(snapshot: Snapshot): void {
    this.mines = [...snapshot.mines]
    this.ledger = [...snapshot.ledger]
    this.dwarfs = [...snapshot.dwarfs]
  }

  private compare(a: Mine, b: Mine, sortBy: MineQuery['sortBy'], sign: number): number {
    switch (sortBy) {
      case 'name':
        return (
          sign *
          (compareText(foldForSearch(a.name), foldForSearch(b.name)) || compareText(a.name, b.name))
        )
      case 'lastUsed':
        return sign * (a.lastUsedAt - b.lastUsedAt)
      case 'tier':
        // A never-measured mine ranks after every measured one, in both directions.
        if (a.tier === null || b.tier === null)
          return Number(a.tier === null) - Number(b.tier === null)
        return (
          sign *
          (TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
            (a.sourceWeight?.bytes ?? 0) - (b.sourceWeight?.bytes ?? 0))
        )
      case 'ore':
        for (const material of ORE_ORDER) {
          const difference = this.tokens(a.id, material) - this.tokens(b.id, material)
          if (difference !== 0) return sign * difference
        }
        return 0
    }
  }

  private tokens(mineId: MineId, material: LedgerMaterial): number {
    return this.ledger
      .filter((entry) => entry.mineId === mineId && entry.material === material)
      .reduce((sum, entry) => sum + entry.tokens, 0)
  }
}

function copyOf(mine: Mine | undefined): Mine | null {
  return mine === undefined ? null : structuredClone(mine)
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function byId(a: Mine, b: Mine): number {
  return compareText(a.id, b.id)
}
