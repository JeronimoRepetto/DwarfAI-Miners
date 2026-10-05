// The ledger module (05 §3.10): ore, six materials per mine, never converted or summed (INV-93),
// credited once per usage unit (ADR-006 items 4–9). Cut 1 serves `creditUsage`,
// `creditSealedUnits` and `totals` (ISSUE-076); the coal backfill joins with ISSUE-077, offline
// catch-up is observation's (ISSUE-078), and the Reset step comes with ISSUE-097. It imports no
// other module (05 §1.3): it is driven by event routes composed in `host/wiring` (later:
// ISSUE-096).
import type { UsageObservation } from '../../kernel/domain/sharedContracts'
import type { MineId } from '../../kernel/domain/values'
import { creditSealedUnits } from './application/creditSealedUnits'
import { creditUsage, totals } from './application/creditUsage'
import { Crediting, type CreditingDeps } from './application/crediting'
import type { UsagePath } from './domain/credit'
import type { MaterialTotals } from './domain/materials'

export type { LedgerEvent, LedgerTotalsChanged, MaterialCredited } from './domain/events'
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
  BestObservation,
  CreditOutcome,
  CreditSubject,
  LedgerRepository,
  StoredUsageUnit
} from './ports/ledgerRepository'
export type { CreditingDeps as LedgerDeps } from './application/crediting'

/**
 * 16 §4.10 `LedgerCommands` as amended 2026-10-05 (`creditUsage` takes the route's `path`), with
 * the members built in cut 1 (`runCoalBackfill` joins with ISSUE-077, unchanged).
 */
export interface LedgerCommands {
  creditUsage(o: UsageObservation, path: UsagePath): 'credited' | 'stored' | 'duplicate'
  creditSealedUnits(mineId: MineId): { credited: number }
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

/** The module over its driven ports; the adapters are composed by `host/main.ts` (ISSUE-096). */
export function createLedger(deps: CreditingDeps): Ledger {
  const crediting = new Crediting(deps)
  return {
    commands: {
      creditUsage: (o, path) => creditUsage(crediting, o, path),
      creditSealedUnits: (mineId) => creditSealedUnits(crediting, mineId)
    },
    queries: { totals: (mineId) => totals(crediting, mineId) },
    joinedEvents: {
      publish: () => crediting.publishJoined(),
      discard: () => crediting.discardJoined()
    }
  }
}
