// Driven port of the ledger (05 §3.10; 16 §4.10 as amended by the owner on 2026-10-05 for
// ISSUE-076). Type-only (05 R2).
//
// Amendment (owner decision 2026-10-05, option A): 16 §4.10's `LedgerRepository` gains the reads
// 09 §5.3 step 2 decides creditability from (`subjectOf`, `confirmedTier`, `resetInProgress`,
// `unit`, `sealedUncredited`), `record` takes the observation's `path` (09 §4.7
// `usage_observations.path` is NOT NULL), and `credit` returns the new entry's id, which
// `LedgerTotalsChanged` carries (08 §0). Every other member keeps its 16 §4.10 signature. The
// members built so far are declared here; `wipe` is not (the Reset saga's ledger step,
// `LedgerResetStep`, deletes the ledger's tables in its `db` transaction, ISSUE-097).
// `setInstallMoment` joined with the Reset steps' registration (ISSUE-121). `backfillState`, `setBackfillState` and `markScanUnit` (ISSUE-077)
// keep their 16 §4.10 signatures, unchanged by the amendment.
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
// - `backfillState()` reads `install_moment.backfill_state`, `backfill_done_at` and the current
//   moment's `coal_backfill_units` (09 §5.5); with no install moment it is `not-started` with no
//   units. `setBackfillState(s)` writes `s.state` and `s.doneAt` (set exactly when `done`, the
//   table CHECK); scan units are rows only `markScanUnit` adds and only the install moment's
//   deletion removes (cascade), so `s.creditedScanUnits` is not written, and with no install moment
//   it writes nothing. `markScanUnit(unit, at)` inserts the unit's `coal_backfill_units` row
//   (`'duplicate'`: already recorded, nothing written); with no install moment it throws (the
//   foreign key). The three writes join the caller's transaction; outside one they throw.
// - `setInstallMoment(t)` writes the install moment `t` that the Reset saga's `install-moment`
//   step records (07 S13.05), replacing any moment there: the old moment's backfill progress goes
//   with it and the new one is `not-started` with no scan units (S19.01). It joins the caller's
//   transaction; outside one it throws and writes nothing.
import type { UsageObservation } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, Instant, MineId } from '../../../kernel/domain/values'
import type { CoalBackfillProgress } from '../domain/coalBackfill'
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

/** 16 §4.10 `BackfillState`: 06 §0 `CoalBackfillProgress` (package gap: 16 names it without fields). */
export type BackfillState = CoalBackfillProgress

/**
 * 16 §4.10 `ScanUnitKey`: one finished scan unit as its `coal_backfill_units` row records it.
 * Package gap: 16 names the type without fields; the row it keys (09 §4, 10 `coal_backfill_units`)
 * also needs the scanning adapter and the coal tokens credited from the unit, and
 * `markScanUnit(unit, at)` has no other argument to carry them.
 */
export interface ScanUnitKey {
  /** `scan_unit` (PK): a Claude project directory, a Codex day directory, the OpenCode store. */
  scanUnit: string
  /** `adapter_id`: the provider whose history it is (open vocabulary). */
  adapterId: string
  /** `tokens_credited`: coal tokens credited from this unit (diagnostics). */
  tokensCredited: number
}

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
  /** 16 §4.10: the Reset saga's new install moment (07 S13.05). */
  setInstallMoment(t: Instant): void
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
  /** 16 §4.10: `install_moment.backfill_*` and the moment's `coal_backfill_units`. */
  backfillState(): BackfillState
  /** 16 §4.10: writes `backfill_state` and `backfill_done_at`. */
  setBackfillState(s: BackfillState): void
  /** 16 §4.10: one `coal_backfill_units` row per finished scan unit, with its credits' transaction. */
  markScanUnit(unit: ScanUnitKey, at: Instant): 'new' | 'duplicate'
}
