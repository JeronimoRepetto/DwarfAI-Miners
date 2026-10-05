// `SqliteLedgerRepository` (16 §4.10; 05 §3.10): the ledger tables of 09 §4.7 in bound SQL through
// the kernel `SqliteDatabase` port (R11), with the reads 09 §5.3 step 2 makes of `dwarfs`, `mines`,
// `install_moment` and `reset_journal` (16 §4.10 as amended 2026-10-05). It reads
// other modules' rows and writes only the ledger's, as `SqliteMineRepository` reads
// `material_totals`. Replaces today's `sqliteLedgerStore.ts` (a whole-state rewrite of the
// last-seen-counter vault, superseded by ADR-006); nothing of it is kept.
//
// - Every write joins the caller's transaction (16 §2.2); outside one it throws
//   `HostInvariantError` and writes nothing. A statement failure aborts the caller's command
//   (16 §2.1).
// - `record` (09 §5.3 step 1): a `sourceKey` already stored answers `'duplicate'` and writes
//   nothing, not even the unit's seal (INV-90). Otherwise the unit is upserted (`sealed` only ever
//   rises; `provider_time` and `sealed_at` become those of the sealing record) and the observation
//   is inserted with the `path` it arrived by.
// - `credit` (09 §5.3 step 3): one insert, `ON CONFLICT (unit_key) DO NOTHING`, so a unit has one
//   entry whatever path or retry reaches it (ADR-006 item 5), and answers the new entry's id; its
//   `source_key` is the unit's best
//   observation on the dwarf's stored path. The `ledger_entries_accumulate` trigger adds it to
//   `material_totals` in the same transaction (ADR-006 item 9); the coal CHECK and
//   `ledger_entries_immutable` stay the database's backstops (INV-95, INV-99).
// - The coal backfill's progress (09 §5.5): `install_moment.backfill_*` and one
//   `coal_backfill_units` row per finished scan unit (`ON CONFLICT (scan_unit) DO NOTHING`), whose
//   foreign key ties it to the current moment and goes with it (cascade). The table CHECK keeps
//   `backfill_done_at` set exactly when the state is `done`.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { UsageObservation } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, Instant, MineId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { SqliteDatabase, SqliteRow } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { CoalBackfillState } from '../domain/coalBackfill'
import type { UnitKey, UsagePath } from '../domain/credit'
import {
  MATERIALS,
  zeroTotals,
  type LiveMaterial,
  type Material,
  type MaterialTotals
} from '../domain/materials'
import type {
  BackfillState,
  BestObservation,
  CreditOutcome,
  CreditSubject,
  LedgerRepository,
  ScanUnitKey,
  StoredUsageUnit
} from '../ports/ledgerRepository'

export interface SqliteLedgerRepositoryDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
  /** `ledger_entries.id`. */
  ids: IdGenerator
  /** `ledger_entries.credited_at`. */
  clock: Clock
}

const OBSERVATION_EXISTS = 'SELECT 1 AS found FROM usage_observations WHERE source_key = ?'

const UPSERT_UNIT = `INSERT INTO usage_units
    (unit_key, dwarf_id, mine_id, sealed, provider_time, first_observed_at, sealed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (unit_key) DO UPDATE SET
    provider_time = CASE WHEN usage_units.sealed = 0 AND excluded.sealed = 1
                         THEN excluded.provider_time ELSE usage_units.provider_time END,
    sealed_at     = CASE WHEN usage_units.sealed = 0 AND excluded.sealed = 1
                         THEN excluded.sealed_at ELSE usage_units.sealed_at END,
    sealed        = max(usage_units.sealed, excluded.sealed)`

const INSERT_OBSERVATION = `INSERT INTO usage_observations
    (source_key, unit_key, path, fidelity, input_net, output, cache_read, cache_write, reasoning,
     sealed, provider_time, observed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const INSERT_ENTRY = `INSERT INTO ledger_entries
    (id, unit_key, mine_id, material, tokens, units, kind, source_key, credited_at)
  VALUES (?, ?, ?, ?, ?, ?, ?,
    (SELECT o.source_key FROM usage_observations o
       JOIN usage_units u ON u.unit_key = o.unit_key
       JOIN dwarfs d ON d.id = u.dwarf_id
      WHERE o.unit_key = ? AND o.path = d.usage_path
      ORDER BY o.fidelity DESC, o.observed_at ASC, o.source_key ASC LIMIT 1),
    ?)
  ON CONFLICT (unit_key) DO NOTHING`

const TOTALS = 'SELECT material, tokens FROM material_totals WHERE mine_id = ?'

const INSTALL_MOMENT = 'SELECT at FROM install_moment WHERE id = 1'

const SUBJECT = 'SELECT mine_id, usage_path FROM dwarfs WHERE id = ?'

const CONFIRMED_TIER =
  'SELECT tier FROM mines WHERE id = ? AND has_been_measured = 1 AND tier IS NOT NULL'

const RESET_IN_PROGRESS = "SELECT 1 AS found FROM reset_journal WHERE step <> 'done' LIMIT 1"

const UNIT = `SELECT u.unit_key, u.dwarf_id, u.mine_id, u.sealed, u.provider_time, u.first_observed_at,
    EXISTS (SELECT 1 FROM ledger_entries e WHERE e.unit_key = u.unit_key) AS credited
  FROM usage_units u WHERE u.unit_key = ?`

// `usage_observations_unit` serves it: highest fidelity, ties to the earlier (ADR-006 item 5).
const BEST = `SELECT source_key, input_net + output + cache_read + cache_write + reasoning AS tokens
  FROM usage_observations WHERE unit_key = ? AND path = ?
  ORDER BY fidelity DESC, observed_at ASC, source_key ASC LIMIT 1`

// `usage_units_mine_sealed` serves it.
const SEALED_UNCREDITED = `SELECT u.unit_key FROM usage_units u
  WHERE u.mine_id = ? AND u.sealed = 1
    AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.unit_key = u.unit_key)
  ORDER BY u.first_observed_at, u.unit_key`

const BACKFILL_STATE = 'SELECT backfill_state, backfill_done_at FROM install_moment WHERE id = 1'

const SCAN_UNITS = 'SELECT scan_unit FROM coal_backfill_units ORDER BY scan_unit'

// No row (between a reset's `db` and `install-moment` steps): nothing to write.
const SET_BACKFILL_STATE =
  'UPDATE install_moment SET backfill_state = ?, backfill_done_at = ? WHERE id = 1'

// `install_moment_id` defaults to the one moment; without it the foreign key refuses the row.
const MARK_SCAN_UNIT = `INSERT INTO coal_backfill_units
    (scan_unit, adapter_id, tokens_credited, credited_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (scan_unit) DO NOTHING`

const PATHS: readonly UsagePath[] = ['driver', 'transcript']

export class SqliteLedgerRepository implements LedgerRepository {
  constructor(private readonly deps: SqliteLedgerRepositoryDeps) {}

  record(o: UsageObservation, mineId: MineId, path: UsagePath): 'new' | 'duplicate' {
    this.requireTransaction('record')
    const { db } = this.deps
    if (db.all(OBSERVATION_EXISTS, [o.sourceKey]).length > 0) return 'duplicate'
    const sealed = o.sealed ? 1 : 0
    db.run(UPSERT_UNIT, [
      o.unitKey,
      o.dwarfId,
      mineId,
      sealed,
      o.providerTime,
      o.observedAt,
      o.sealed ? o.observedAt : null
    ])
    db.run(INSERT_OBSERVATION, [
      o.sourceKey,
      o.unitKey,
      path,
      o.fidelity,
      o.tokens.inputNet,
      o.tokens.output,
      o.tokens.cacheRead,
      o.tokens.cacheWrite,
      o.tokens.reasoning,
      sealed,
      o.providerTime,
      o.observedAt
    ])
    return 'new'
  }

  credit(
    unitKey: UnitKey,
    mineId: MineId,
    m: Material,
    tokens: number,
    units: number,
    kind: 'live' | 'coal-backfill'
  ): CreditOutcome {
    this.requireTransaction('credit')
    const ledgerEntryId = this.deps.ids.uuidv7()
    const { changes } = this.deps.db.run(INSERT_ENTRY, [
      ledgerEntryId,
      unitKey,
      mineId,
      m,
      tokens,
      units,
      kind,
      unitKey,
      this.deps.clock.now()
    ])
    return changes === 1 ? { outcome: 'credited', ledgerEntryId } : { outcome: 'duplicate' }
  }

  totals(mineId: MineId): MaterialTotals {
    const totals = zeroTotals()
    for (const row of this.deps.db.all(TOTALS, [mineId])) {
      const material = row['material'] as Material
      if (MATERIALS.includes(material)) totals[material] = { tokens: Number(row['tokens']) }
    }
    return totals
  }

  installMoment(): Instant | null {
    const row = this.deps.db.all(INSTALL_MOMENT)[0]
    return row === undefined ? null : Number(row['at'])
  }

  subjectOf(dwarfId: DwarfId): CreditSubject | null {
    const row = this.deps.db.all(SUBJECT, [dwarfId])[0]
    if (row === undefined) return null
    return { mineId: String(row['mine_id']) as MineId, usagePath: row['usage_path'] as UsagePath }
  }

  confirmedTier(mineId: MineId): LiveMaterial | null {
    const row = this.deps.db.all(CONFIRMED_TIER, [mineId])[0]
    return row === undefined ? null : (row['tier'] as LiveMaterial)
  }

  resetInProgress(): boolean {
    return this.deps.db.all(RESET_IN_PROGRESS).length > 0
  }

  unit(unitKey: UnitKey): StoredUsageUnit | null {
    const row = this.deps.db.all(UNIT, [unitKey])[0]
    if (row === undefined) return null
    const best: Partial<Record<UsagePath, BestObservation>> = {}
    for (const path of PATHS) {
      const found = this.deps.db.all(BEST, [unitKey, path])[0]
      if (found !== undefined) best[path] = toBest(found)
    }
    return {
      unitKey: String(row['unit_key']),
      dwarfId: String(row['dwarf_id']) as DwarfId,
      mineId: String(row['mine_id']) as MineId,
      sealed: Number(row['sealed']) === 1,
      providerTime: row['provider_time'] === null ? null : Number(row['provider_time']),
      firstObservedAt: Number(row['first_observed_at']),
      credited: Number(row['credited']) === 1,
      best
    }
  }

  sealedUncredited(mineId: MineId): UnitKey[] {
    return this.deps.db.all(SEALED_UNCREDITED, [mineId]).map((row) => String(row['unit_key']))
  }

  backfillState(): BackfillState {
    const row = this.deps.db.all(BACKFILL_STATE)[0]
    if (row === undefined) return { state: 'not-started', creditedScanUnits: [] }
    const creditedScanUnits = this.deps.db.all(SCAN_UNITS).map((unit) => String(unit['scan_unit']))
    const doneAt = row['backfill_done_at']
    return {
      state: row['backfill_state'] as CoalBackfillState,
      creditedScanUnits,
      ...(doneAt === null ? {} : { doneAt: Number(doneAt) })
    }
  }

  setBackfillState(s: BackfillState): void {
    this.requireTransaction('setBackfillState')
    this.deps.db.run(SET_BACKFILL_STATE, [s.state, s.doneAt ?? null])
  }

  markScanUnit(unit: ScanUnitKey, at: Instant): 'new' | 'duplicate' {
    this.requireTransaction('markScanUnit')
    const { changes } = this.deps.db.run(MARK_SCAN_UNIT, [
      unit.scanUnit,
      unit.adapterId,
      unit.tokensCredited,
      at
    ])
    return changes === 1 ? 'new' : 'duplicate'
  }

  private requireTransaction(method: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        `LedgerRepository.${method} outside a transaction; it joins the caller's (16 §2.2)`
      )
    }
  }
}

function toBest(row: SqliteRow): BestObservation {
  return { sourceKey: String(row['source_key']), tokens: Number(row['tokens']) }
}
