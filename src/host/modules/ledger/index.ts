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
  CreditSubject,
  LedgerRepository,
  LedgerStore,
  StoredUsageUnit,
  UsageUnitReads
} from './ports/ledgerRepository'
export type { CreditingDeps as LedgerDeps } from './application/crediting'

/**
 * 16 §4.10 `LedgerCommands`, with the members built in cut 1 (`runCoalBackfill` joins with
 * ISSUE-077).
 */
export interface LedgerCommands {
  creditUsage(o: UsageObservation): 'credited' | 'stored' | 'duplicate'
  creditSealedUnits(mineId: MineId): { credited: number }
}

/** 16 §4.10 `LedgerQueries`. */
export interface LedgerQueries {
  totals(mineId: MineId): MaterialTotals
}

export interface Ledger {
  /** The commands of one usage path's route (see application/creditUsage.ts). */
  commandsFor(path: UsagePath): LedgerCommands
  queries: LedgerQueries
  /**
   * The caller's transaction that the ledger joined has committed: publishes the events of the
   * credits made inside it (see application/crediting.ts).
   */
  publishCommitted(): void
  /** That transaction rolled back: its credits never happened, their events are dropped. */
  discardUncommitted(): void
}

/** The module over its driven ports; the adapters are composed by `host/main.ts` (ISSUE-096). */
export function createLedger(deps: CreditingDeps): Ledger {
  const crediting = new Crediting(deps)
  const commands = (path: UsagePath): LedgerCommands => ({
    creditUsage: (o) => creditUsage(crediting, path, o),
    creditSealedUnits: (mineId) => creditSealedUnits(crediting, mineId)
  })
  const byPath: Readonly<Record<UsagePath, LedgerCommands>> = {
    driver: commands('driver'),
    transcript: commands('transcript')
  }
  return {
    commandsFor: (path) => byPath[path],
    queries: { totals: (mineId) => totals(crediting, mineId) },
    publishCommitted: () => crediting.publishCommitted(),
    discardUncommitted: () => crediting.discardUncommitted()
  }
}
