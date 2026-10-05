// Driven ports of the ledger (05 §3.10; 16 §4.10). Type-only (05 R2).
//
// `LedgerRepository` is 16 §4.10's, with the members this issue builds: `record`, `credit`,
// `totals`, `installMoment`. The others join with their issues: `setInstallMoment` and `wipe` with
// the Reset steps (later: ISSUE-097), `backfillState`, `setBackfillState` and `markScanUnit` with
// the coal backfill (later: ISSUE-077).
//
// - `record(o, mineId)` stores the observation by its `sourceKey` (INV-90) and upserts its unit
//   (09 §5.3 step 1: `sealed = max(sealed, excluded.sealed)`, the unit's `provider_time` and
//   `sealed_at` are those of its sealing record). `'duplicate'`: the `sourceKey` was already
//   stored, and nothing was written. The observation's path (`usage_observations.path`) is the
//   path the repository instance serves, fixed when the composition creates it (one instance per
//   path; Package gap below).
// - `credit(...)` inserts the one `LedgerEntry` of a unit (`kind = 'live'` here; coal only as
//   `'coal-backfill'`, the table CHECK) and the database trigger adds it to `material_totals` in the
//   same transaction (ADR-006 item 9). `'duplicate'`: the unit already has its entry, nothing was
//   written. Entries are never updated (`ledger_entries_immutable`, INV-99).
// - Both writes join the caller's transaction (16 §2.2); outside one they throw.
//
// Package gap (recorded in the ISSUE-076 hand-off): 16 §4.10's `LedgerRepository` writes and sums,
// but 09 §5.3 step 2 decides creditability from facts it has no member for (the dwarf's mine and
// stored `usage_path`, the mine's confirmed tier, an unfinished reset saga, the unit's sealed state,
// its existing credit and its best observation per path), `record` takes no path while
// `usage_observations.path` is NOT NULL, and `credit` returns no `ledgerEntryId` while
// `LedgerTotalsChanged` carries one (08 §0). `UsageUnitReads` holds exactly those reads, the path is
// an adapter construction parameter, and the frozen members keep their 16 §4.10 signatures.
import type { UsageObservation } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, Instant, MineId } from '../../../kernel/domain/values'
import type { UnitKey, UsagePath, UsageUnit } from '../domain/credit'
import type { LiveMaterial, Material, MaterialTotals } from '../domain/materials'

export interface LedgerRepository {
  record(o: UsageObservation, mineId: MineId): 'new' | 'duplicate'
  credit(
    unitKey: UnitKey,
    mineId: MineId,
    m: Material,
    tokens: number,
    units: number,
    kind: 'live' | 'coal-backfill'
  ): 'credited' | 'duplicate'
  totals(mineId: MineId): MaterialTotals
  installMoment(): Instant | null
}

/** Where a dwarf's usage is credited, and from which path (`dwarfs.mine_id`, `dwarfs.usage_path`). */
export interface CreditSubject {
  mineId: MineId
  /** Written once when the dwarf is bound, never changed (INV-92; 09 §5.3 step 2). */
  usagePath: UsagePath
}

/** The best stored observation of a unit on one path (ADR-006 item 5). */
export interface BestObservation {
  sourceKey: string
  /** Its credited tokens: every kind added together (`usageTokens`). */
  tokens: number
}

/** A stored unit with what crediting it needs. */
export interface StoredUsageUnit extends UsageUnit {
  dwarfId: DwarfId
  mineId: MineId
  /** The highest-fidelity observation per path, ties to the earlier (`usage_observations_unit`). */
  best: Partial<Record<UsagePath, BestObservation>>
}

/** The reads of 09 §5.3 step 2, inside the crediting transaction. */
export interface UsageUnitReads {
  /** The dwarf's mine and authoritative path; null for a dwarf the database does not hold. */
  subjectOf(dwarfId: DwarfId): CreditSubject | null
  /** `mines.tier` once `has_been_measured = 1`; null for a never-measured or unknown mine. */
  confirmedTier(mineId: MineId): LiveMaterial | null
  /** A `reset_journal` row has `step <> 'done'` (ADR-023 item 4). */
  resetInProgress(): boolean
  unit(unitKey: UnitKey): StoredUsageUnit | null
  /** The mine's stored, sealed units that have no entry yet (`usage_units_mine_sealed`), oldest first. */
  sealedUncredited(mineId: MineId): UnitKey[]
  /** The id of the unit's `LedgerEntry` (`ledger_entries.id`), null before its credit. */
  entryOf(unitKey: UnitKey): string | null
}

/** One adapter serves both: the repository of 16 §4.10 and the reads it lacks. */
export type LedgerStore = LedgerRepository & UsageUnitReads
