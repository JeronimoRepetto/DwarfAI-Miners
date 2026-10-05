// Driven port of the ledger (05 §3.10; 16 §4.10 as amended by the owner on 2026-10-05 for
// ISSUE-076). Type-only (05 R2).
//
// Amendment (owner decision 2026-10-05, option A): 16 §4.10's `LedgerRepository` gains the reads
// 09 §5.3 step 2 decides creditability from (`subjectOf`, `confirmedTier`, `resetInProgress`,
// `unit`, `sealedUncredited`), `record` takes the observation's `path` (09 §4.7
// `usage_observations.path` is NOT NULL), and `credit` returns the new entry's id, which
// `LedgerTotalsChanged` carries (08 §0). Every other member keeps its 16 §4.10 signature. The
// members this issue builds are declared here; `setInstallMoment` and `wipe` join with the Reset
// steps (later: ISSUE-097), `backfillState`, `setBackfillState` and `markScanUnit` with the coal
// backfill (later: ISSUE-077), unchanged by the amendment.
//
// - `record(o, mineId, path)` stores the observation by its `sourceKey` (INV-90) and upserts its
//   unit (09 §5.3 step 1: `sealed = max(sealed, excluded.sealed)`, the unit's `provider_time` and
//   `sealed_at` are those of its sealing record). `'duplicate'`: the `sourceKey` was already
//   stored, and nothing was written.
// - `credit(...)` inserts the one `LedgerEntry` of a unit (`kind = 'live'` here; coal only as
//   `'coal-backfill'`, the table CHECK) and the database trigger adds it to `material_totals` in the
//   same transaction (ADR-006 item 9). `'duplicate'`: the unit already has its entry, nothing was
//   written. Entries are never updated (`ledger_entries_immutable`, INV-99).
// - Both writes join the caller's transaction (16 §2.2); outside one they throw. The reads see the
//   caller's open transaction.
import type { UsageObservation } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, Instant, MineId } from '../../../kernel/domain/values'
import type { UnitKey, UsagePath, UsageUnit } from '../domain/credit'
import type { LiveMaterial, Material, MaterialTotals } from '../domain/materials'

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

/** What `credit` answers: the new entry's id (`ledger_entries.id`), or that the unit had one. */
export type CreditOutcome =
  { outcome: 'credited'; ledgerEntryId: string } | { outcome: 'duplicate' }

export interface LedgerRepository {
  /** Amended: + `path`, the observation's path (`usage_observations.path`, 09 §4.7). */
  record(o: UsageObservation, mineId: MineId, path: UsagePath): 'new' | 'duplicate'
  /** Amended: answers the entry id `LedgerTotalsChanged` carries (08 §0). */
  credit(
    unitKey: UnitKey,
    mineId: MineId,
    m: Material,
    tokens: number,
    units: number,
    kind: 'live' | 'coal-backfill'
  ): CreditOutcome
  totals(mineId: MineId): MaterialTotals
  installMoment(): Instant | null
  /** Amended: the dwarf's mine and stored authoritative path; null for a dwarf the database does not hold. */
  subjectOf(dwarfId: DwarfId): CreditSubject | null
  /** Amended: `mines.tier` once `has_been_measured = 1`; null for a never-measured or unknown mine. */
  confirmedTier(mineId: MineId): LiveMaterial | null
  /** Amended: a `reset_journal` row has `step <> 'done'` (ADR-023 item 4). */
  resetInProgress(): boolean
  /** Amended: the stored unit, its credit and its best observation per path. */
  unit(unitKey: UnitKey): StoredUsageUnit | null
  /** Amended: the mine's stored, sealed units without an entry (`usage_units_mine_sealed`), oldest first. */
  sealedUncredited(mineId: MineId): UnitKey[]
}
