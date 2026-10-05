// The public events of the ledger (08 §0; 16 §4.10). Published after commit (16 §2.3).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { MineId } from '../../../kernel/domain/values'
import type { BackfillReport } from './coalBackfill'
import type { UnitKey } from './credit'
import type { Material, MaterialTotals } from './materials'

/** 08 `MaterialCredited`: once per `unitKey` (diagnostics, no frame). */
export type MaterialCredited = DomainEvent<
  'MaterialCredited',
  {
    mineId: MineId
    material: Material
    tokens: number
    units: number
    unitKey: UnitKey
    kind: 'live' | 'coal-backfill'
  }
>

/** 08 `LedgerTotalsChanged`: keyed by `(mineId, ledgerEntryId)`; frame `ledger.changed` (B-F20). */
export type LedgerTotalsChanged = DomainEvent<
  'LedgerTotalsChanged',
  { mineId: MineId; ledgerEntryId: string; totals: MaterialTotals }
>

/** 08 `CoalBackfillFinished`: once per install moment, when its scan is complete (S19.05; no frame). */
export type CoalBackfillFinished = DomainEvent<'CoalBackfillFinished', { report: BackfillReport }>

/** Every event this module publishes. */
export type LedgerEvent = MaterialCredited | LedgerTotalsChanged | CoalBackfillFinished
