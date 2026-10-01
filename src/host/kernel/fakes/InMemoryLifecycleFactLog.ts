// The LifecycleFactLog double (16 §3). Never imported by production code (R14).
//
// The same natural keys as the SQLite adapter (`lifecycleFactKey`, one departure per dwarf) and
// the same trim (newest 50 `TurnEnded` rows per dwarf, by insert order). It has no transaction of
// its own: `record` refuses to run unless the injected `TransactionScope` reports one open, and a
// test's transaction rolls it back with `snapshot` / `restore`.
import { HostInvariantError } from '../domain/errors'
import { lifecycleFactKey } from '../domain/lifecycleFact'
import type { LifecycleFact, LifecycleFactLog } from '../ports/lifecycleFactLog'
import type { TransactionScope } from '../ports/transactionScope'

/** `TurnEnded` rows kept per dwarf (09 §5.6, §7.1). */
const TURN_ENDS_KEPT = 50

export interface InMemoryLifecycleFactRow {
  type: LifecycleFact['type']
  dwarfId: string
  sourceKey: string | null
}

export class InMemoryLifecycleFactLog implements LifecycleFactLog {
  private stored: InMemoryLifecycleFactRow[] = []

  constructor(private readonly scope: TransactionScope) {}

  record(fact: LifecycleFact): 'new' | 'duplicate' {
    if (!this.scope.isInTransaction()) {
      throw new HostInvariantError(
        'LifecycleFactLog.record runs inside the caller transaction (16 §2.2)'
      )
    }
    const sourceKey = lifecycleFactKey(fact)
    if (this.isDuplicate(fact, sourceKey)) return 'duplicate'
    this.stored.push({ type: fact.type, dwarfId: fact.dwarfId, sourceKey })
    if (fact.type === 'TurnEnded') this.trimTurnEnds(fact.dwarfId)
    return 'new'
  }

  /** Every stored row, oldest insert first. */
  rows(): InMemoryLifecycleFactRow[] {
    return this.stored.map((row) => ({ ...row }))
  }

  /** The stored rows, for a test transaction to restore on rollback. */
  snapshot(): readonly InMemoryLifecycleFactRow[] {
    return [...this.stored]
  }

  restore(snapshot: readonly InMemoryLifecycleFactRow[]): void {
    this.stored = [...snapshot]
  }

  private isDuplicate(fact: LifecycleFact, sourceKey: string | null): boolean {
    return this.stored.some(
      (row) =>
        (sourceKey !== null && row.sourceKey === sourceKey) ||
        (fact.type === 'DwarfDeparted' &&
          row.type === 'DwarfDeparted' &&
          row.dwarfId === fact.dwarfId)
    )
  }

  private trimTurnEnds(dwarfId: string): void {
    const isTurnEnd = (row: InMemoryLifecycleFactRow) =>
      row.type === 'TurnEnded' && row.dwarfId === dwarfId
    let excess = this.stored.filter(isTurnEnd).length - TURN_ENDS_KEPT
    if (excess <= 0) return
    this.stored = this.stored.filter((row) => {
      if (excess > 0 && isTurnEnd(row)) {
        excess -= 1
        return false
      }
      return true
    })
  }
}
