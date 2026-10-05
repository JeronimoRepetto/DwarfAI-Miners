// The LedgerRepository double (16 §4.10 `InMemoryLedgerRepository`; 16 §2.8): the rows of
// `usage_units`, `usage_observations`, `ledger_entries`, the coal backfill's
// `install_moment.backfill_*` and `coal_backfill_units` (09 §5.5), and the facts of `dwarfs`,
// `mines`, `install_moment` and `reset_journal` that 09 §5.3 reads, kept in one `InMemoryLedgerWorld`
// that every instance over the same storage shares. It passes `runLedgerRepositoryContract`, as the
// SQLite adapter does. Never imported by production code (R14).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { UsageObservation } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, Instant, MineId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { CoalBackfillState } from '../domain/coalBackfill'
import { usageTokens, type UnitKey, type UsagePath } from '../domain/credit'
import {
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

interface UnitRow {
  unitKey: UnitKey
  dwarfId: DwarfId
  mineId: MineId
  sealed: boolean
  providerTime: Instant | null
  firstObservedAt: Instant
}

interface ObservationRow {
  sourceKey: string
  unitKey: UnitKey
  path: UsagePath
  fidelity: number
  tokens: number
  observedAt: Instant
}

export interface EntryRow {
  id: string
  unitKey: UnitKey
  mineId: MineId
  material: Material
  tokens: number
  units: number
  kind: 'live' | 'coal-backfill'
  creditedAt: Instant
}

/** One `coal_backfill_units` row. */
interface ScanUnitRow {
  adapterId: string
  tokensCredited: number
  creditedAt: Instant
}

/** `install_moment.backfill_*` and the moment's `coal_backfill_units` (cascade on deletion). */
interface BackfillRows {
  state: CoalBackfillState
  doneAt: Instant | null
  scanUnits: Map<string, ScanUnitRow>
}

function freshBackfill(): BackfillRows {
  return { state: 'not-started', doneAt: null, scanUnits: new Map() }
}

interface WorldRows {
  dwarfs: Map<DwarfId, CreditSubject>
  tiers: Map<MineId, LiveMaterial | null>
  installMomentAt: Instant | null
  resetInProgress: boolean
  units: Map<UnitKey, UnitRow>
  observations: Map<string, ObservationRow>
  entries: Map<UnitKey, EntryRow>
  backfill: BackfillRows
}

function copyRows(rows: WorldRows): WorldRows {
  return {
    dwarfs: new Map(rows.dwarfs),
    tiers: new Map(rows.tiers),
    installMomentAt: rows.installMomentAt,
    resetInProgress: rows.resetInProgress,
    units: new Map([...rows.units].map(([key, row]) => [key, { ...row }])),
    observations: new Map(rows.observations),
    entries: new Map(rows.entries),
    backfill: { ...rows.backfill, scanUnits: new Map(rows.backfill.scanUnits) }
  }
}

/** The shared storage of every `InMemoryLedgerRepository`; a rolled-back transaction restores it. */
export class InMemoryLedgerWorld {
  rows: WorldRows = {
    dwarfs: new Map(),
    tiers: new Map(),
    installMomentAt: null,
    resetInProgress: false,
    units: new Map(),
    observations: new Map(),
    entries: new Map(),
    backfill: freshBackfill()
  }

  snapshot(): WorldRows {
    return copyRows(this.rows)
  }

  restore(snapshot: WorldRows): void {
    this.rows = copyRows(snapshot)
  }

  /**
   * Deletes the install moment and writes `at` (`null`: none), as migration 1 and a reset's
   * steps do: the old moment's backfill progress goes with it and a new one is `not-started`.
   */
  writeInstallMoment(at: Instant | null): void {
    this.rows.installMomentAt = at
    this.rows.backfill = freshBackfill()
  }
}

export interface InMemoryLedgerRepositoryDeps {
  world: InMemoryLedgerWorld
  scope: TransactionScope
  ids: IdGenerator
  clock: Clock
}

export class InMemoryLedgerRepository implements LedgerRepository {
  constructor(private readonly deps: InMemoryLedgerRepositoryDeps) {}

  private get rows(): WorldRows {
    return this.deps.world.rows
  }

  record(o: UsageObservation, mineId: MineId, path: UsagePath): 'new' | 'duplicate' {
    this.requireTransaction('record')
    if (this.rows.observations.has(o.sourceKey)) return 'duplicate'
    const existing = this.rows.units.get(o.unitKey)
    if (existing === undefined) {
      this.rows.units.set(o.unitKey, {
        unitKey: o.unitKey,
        dwarfId: o.dwarfId as DwarfId,
        mineId,
        sealed: o.sealed,
        providerTime: o.providerTime,
        firstObservedAt: o.observedAt
      })
    } else if (o.sealed && !existing.sealed) {
      // 09 §5.3 step 1: the unit's provider time is that of its sealing record.
      existing.sealed = true
      existing.providerTime = o.providerTime
    }
    this.rows.observations.set(o.sourceKey, {
      sourceKey: o.sourceKey,
      unitKey: o.unitKey,
      path,
      fidelity: o.fidelity,
      tokens: usageTokens(o.tokens),
      observedAt: o.observedAt
    })
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
    if (this.rows.entries.has(unitKey)) return { outcome: 'duplicate' }
    // The table CHECK of 09 §4.7: coal only via the backfill, and the backfill pays only coal.
    if ((kind === 'coal-backfill') !== (m === 'coal')) {
      throw new HostInvariantError(`a ${kind} credit of ${m} violates the ledger_entries CHECK`)
    }
    const ledgerEntryId = this.deps.ids.uuidv7()
    this.rows.entries.set(unitKey, {
      id: ledgerEntryId,
      unitKey,
      mineId,
      material: m,
      tokens,
      units,
      kind,
      creditedAt: this.deps.clock.now()
    })
    return { outcome: 'credited', ledgerEntryId }
  }

  totals(mineId: MineId): MaterialTotals {
    const totals = zeroTotals()
    for (const entry of this.rows.entries.values()) {
      if (entry.mineId === mineId) totals[entry.material].tokens += entry.tokens
    }
    return totals
  }

  installMoment(): Instant | null {
    return this.rows.installMomentAt
  }

  subjectOf(dwarfId: DwarfId): CreditSubject | null {
    const subject = this.rows.dwarfs.get(dwarfId)
    return subject === undefined ? null : { ...subject }
  }

  confirmedTier(mineId: MineId): LiveMaterial | null {
    return this.rows.tiers.get(mineId) ?? null
  }

  resetInProgress(): boolean {
    return this.rows.resetInProgress
  }

  unit(unitKey: UnitKey): StoredUsageUnit | null {
    const row = this.rows.units.get(unitKey)
    if (row === undefined) return null
    const best: Partial<Record<UsagePath, BestObservation>> = {}
    for (const path of ['driver', 'transcript'] as const) {
      const found = this.bestOf(unitKey, path)
      if (found !== null) best[path] = found
    }
    return { ...row, credited: this.rows.entries.has(unitKey), best }
  }

  sealedUncredited(mineId: MineId): UnitKey[] {
    return [...this.rows.units.values()]
      .filter((u) => u.mineId === mineId && u.sealed && !this.rows.entries.has(u.unitKey))
      .sort((a, b) => a.firstObservedAt - b.firstObservedAt || compare(a.unitKey, b.unitKey))
      .map((u) => u.unitKey)
  }

  backfillState(): BackfillState {
    if (this.rows.installMomentAt === null) return { state: 'not-started', creditedScanUnits: [] }
    const { state, doneAt, scanUnits } = this.rows.backfill
    return {
      state,
      creditedScanUnits: [...scanUnits.keys()].sort(compare),
      ...(doneAt === null ? {} : { doneAt })
    }
  }

  setBackfillState(s: BackfillState): void {
    this.requireTransaction('setBackfillState')
    const doneAt = s.doneAt ?? null
    // No row (between a reset's `db` and `install-moment` steps): the UPDATE writes nothing.
    if (this.rows.installMomentAt === null) return
    // The table CHECK: `backfill_done_at` is set exactly when the state is `done`.
    if ((s.state === 'done') !== (doneAt !== null)) {
      throw new HostInvariantError(
        `a ${s.state} backfill with done instant ${String(doneAt)} violates the install_moment CHECK`
      )
    }
    this.rows.backfill.state = s.state
    this.rows.backfill.doneAt = doneAt
  }

  markScanUnit(unit: ScanUnitKey, at: Instant): 'new' | 'duplicate' {
    this.requireTransaction('markScanUnit')
    if (this.rows.installMomentAt === null) {
      throw new HostInvariantError(
        'a coal_backfill_units row without an install moment violates its foreign key'
      )
    }
    const units = this.rows.backfill.scanUnits
    if (units.has(unit.scanUnit)) return 'duplicate'
    units.set(unit.scanUnit, {
      adapterId: unit.adapterId,
      tokensCredited: unit.tokensCredited,
      creditedAt: at
    })
    return 'new'
  }

  /** `usage_observations_unit`: highest fidelity, ties to the earlier, then by key (ADR-006 item 5). */
  private bestOf(unitKey: UnitKey, path: UsagePath): BestObservation | null {
    let best: ObservationRow | null = null
    for (const row of this.rows.observations.values()) {
      if (row.unitKey !== unitKey || row.path !== path) continue
      if (
        best === null ||
        row.fidelity > best.fidelity ||
        (row.fidelity === best.fidelity &&
          (row.observedAt < best.observedAt ||
            (row.observedAt === best.observedAt && row.sourceKey < best.sourceKey)))
      ) {
        best = row
      }
    }
    return best === null ? null : { sourceKey: best.sourceKey, tokens: best.tokens }
  }

  private requireTransaction(method: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        `LedgerRepository.${method} outside a transaction; it joins the caller's (16 §2.2)`
      )
    }
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
