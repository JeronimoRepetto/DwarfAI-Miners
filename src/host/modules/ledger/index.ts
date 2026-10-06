// The ledger module (05 §3.10): ore, six materials per mine, never converted or summed (INV-93),
// credited once per usage unit (ADR-006 items 4–9). Cut 1 serves `creditUsage`,
// `creditSealedUnits` and `totals` (ISSUE-076), the coal backfill `runCoalBackfill`
// (ISSUE-077) and its per-mine run `runMineCoalBackfill` (11 O-11-10, owner ruling 2026-10-06;
// its route lands with ISSUE-108); offline catch-up is observation's (ISSUE-078), and the Reset step comes with
// ISSUE-097. It imports no other module (05 §1.3): it is driven by event routes composed in
// `host/wiring` (routes/ledger.ts and the ObservedBatchSink bridge, ISSUE-096), which also runs
// the backfill once the Host is `ready`.
import type { UsageObservation } from '../../kernel/domain/sharedContracts'
import type { MineId } from '../../kernel/domain/values'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { LedgerResetStep } from './adapters/sqlite/LedgerResetStep'
import {
  runCoalBackfill,
  runMineCoalBackfill,
  type CoalBackfillDeps
} from './application/coalBackfill'
import { creditSealedUnits } from './application/creditSealedUnits'
import { creditUsage, totals } from './application/creditUsage'
import { Crediting, type CreditingDeps } from './application/crediting'
import type { UsagePath } from './domain/credit'
import type { BackfillReport } from './domain/coalBackfill'
import type { MaterialTotals } from './domain/materials'

export type {
  CoalBackfillFinished,
  LedgerEvent,
  LedgerTotalsChanged,
  MaterialCredited
} from './domain/events'
export type { BackfillReport, CoalBackfillState } from './domain/coalBackfill'
export { COAL_SCAN_BUDGET } from './application/coalBackfill'
export {
  MATERIALS,
  TOKENS_PER_UNIT,
  unitsOf,
  zeroTotals,
  type LiveMaterial,
  type Material,
  type MaterialAmount,
  type MaterialTotals
} from './domain/materials'
export type { UnitKey, UsagePath } from './domain/credit'
export type {
  HistoricalUsage,
  HistoricalUsageRecord,
  HistoricalUsageScanner,
  ScanBudget
} from './ports/historicalUsageScanner'
export type {
  BackfillState,
  BestObservation,
  CreditOutcome,
  CreditSubject,
  LedgerRepository,
  ScanUnitKey,
  StoredUsageUnit
} from './ports/ledgerRepository'

/** What the module is built over: the crediting ports and the coal backfill's. */
export interface LedgerDeps extends CreditingDeps, CoalBackfillDeps {}

/**
 * 16 §4.10 `LedgerCommands` as amended 2026-10-05 (`creditUsage` takes the route's `path`);
 * `runCoalBackfill` and `creditSealedUnits` keep their 16 §4.10 signatures.
 *
 * Amendment request (owner ruling on 11 O-11-10, 2026-10-06; to be recorded in 05 §3.10 and its
 * 16 §4.10 copy): `runMineCoalBackfill` is the one member the ruling adds.
 */
export interface LedgerCommands {
  creditUsage(o: UsageObservation, path: UsagePath): 'credited' | 'stored' | 'duplicate'
  runCoalBackfill(signal: AbortSignal): Promise<BackfillReport>
  creditSealedUnits(mineId: MineId): { credited: number }
  /**
   * A mine's pre-install usage as coal, once (O-11-10): routed from `MineCreated` and
   * `MineReattached` (a removed mine's folder resolved to no mine while it was removed; its kept
   * entries are never touched, only units no path paid are added).
   */
  runMineCoalBackfill(mineId: MineId, signal: AbortSignal): Promise<BackfillReport>
}

/** 16 §4.10 `LedgerQueries`. */
export interface LedgerQueries {
  totals(mineId: MineId): MaterialTotals
}

/**
 * The events of credits made inside a caller's open transaction (AMENDMENT-10: the observed batch,
 * 16 §4.3). They are held, never published inside that transaction (16 §2.3): the caller publishes
 * them once its transaction committed, or discards them when it rolled back. The same shape as
 * conversation's `JoinedEvents` (ISSUE-099); a credit outside any transaction publishes itself.
 */
export interface JoinedEvents {
  /** After the caller's commit: publishes the held events, in credit order. */
  publish(): void
  /** After the caller's rollback: drops the held events. */
  discard(): void
}

export interface Ledger {
  commands: LedgerCommands
  queries: LedgerQueries
  joinedEvents: JoinedEvents
}

/** The module over its driven ports; `host/main.ts` composes the adapters (ISSUE-096). */
export function createLedger(deps: LedgerDeps): Ledger {
  const crediting = new Crediting(deps)
  const backfill: CoalBackfillDeps = { scanner: deps.scanner, log: deps.log }
  return {
    commands: {
      creditUsage: (o, path) => creditUsage(crediting, o, path),
      runCoalBackfill: (signal) => runCoalBackfill(crediting, backfill, signal),
      creditSealedUnits: (mineId) => creditSealedUnits(crediting, mineId),
      runMineCoalBackfill: (mineId, signal) =>
        runMineCoalBackfill(crediting, backfill, mineId, signal)
    },
    queries: { totals: (mineId) => totals(crediting, mineId) },
    joinedEvents: {
      publish: () => crediting.publishJoined(),
      discard: () => crediting.discardJoined()
    }
  }
}

/**
 * The ledger step of the Reset-metrics saga (ADR-023; 09 §7.2): the shape of the preferences
 * module's `ResetDbStep` (16 §4.12), stated here so the ledger imports nothing from preferences
 * (05 §1.3, R4). It joins the saga's one `db` transaction.
 */
export interface LedgerResetDbStep {
  readonly name: string
  reset(tx: TransactionRunner): void
}

/** `name: 'ledger'`; registered with the saga by host/wiring/resetParticipants.ts. */
export function createLedgerResetStep(deps: {
  db: SqliteDatabase
  scope: TransactionScope
}): LedgerResetDbStep {
  return new LedgerResetStep(deps)
}
