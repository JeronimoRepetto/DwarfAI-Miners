// The AttentionLedger double (16 §4.11 `InMemoryAttentionLedger`). Never imported by production
// code (R14). It keeps the port's rule that a suppressed key is claimed like an emitted one
// (07 S17.08), and records each write so a test can see what was emitted and what suppressed.
// Its shared contract suite, run by this double and by `SqliteAttentionLedger`, lands with the
// adapter (ISSUE-110, `runAttentionLedgerContract`).
import type { DwarfId } from '../../../../kernel/domain/values'
import type { AttentionKind } from '../../domain/decideLevel3'
import type { AttentionLedger } from '../attentionLedger'

export interface LedgerWrite {
  key: string
  dwarfId: DwarfId
  kind: AttentionKind
  suppressed: boolean
}

export class InMemoryAttentionLedger implements AttentionLedger {
  /** Every claimed key, in write order. */
  readonly writes: LedgerWrite[] = []
  private readonly carried = new Map<string, string>()

  emitted(): ReadonlySet<string> {
    return new Set(this.writes.map((w) => w.key))
  }

  markEmitted(key: string, dwarfId: DwarfId, kind: AttentionKind): void {
    this.claim({ key, dwarfId, kind, suppressed: false })
  }

  markSuppressed(key: string, dwarfId: DwarfId, kind: AttentionKind): void {
    this.claim({ key, dwarfId, kind, suppressed: true })
  }

  carryOver(): ReadonlyMap<string, string> {
    return new Map(this.carried)
  }

  consumeCarryOver(dwarfKind: string): void {
    this.carried.delete(dwarfKind)
  }

  /** A key is claimed once (`attention_keys.key` is the primary key, 09). */
  private claim(write: LedgerWrite): void {
    if (this.writes.some((w) => w.key === write.key)) {
      throw new Error(`attention key ${write.key} is already claimed`)
    }
    this.writes.push(write)
  }
}
