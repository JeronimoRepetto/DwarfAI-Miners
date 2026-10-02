// The AttentionLedger double (16 §4.11 `InMemoryAttentionLedger`). Never imported by production
// code (R14). It runs `runAttentionLedgerContract` like `SqliteAttentionLedger`: its storage is an
// `InMemoryAttentionRows`, and a new ledger over the same rows is what a Host restart opens. It
// keeps the port's rule that a suppressed key is claimed like an emitted one (07 S17.08), and
// records this ledger's writes so a test can see what was emitted and what suppressed.
import type { DwarfId } from '../../../../kernel/domain/values'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import type { Clock } from '../../../../kernel/ports/clock'
import { carryOverKey, type CarriedKind } from '../../domain/carryOver'
import type { AttentionKind } from '../../domain/decideLevel3'
import type { AttentionLedger } from '../attentionLedger'

export interface LedgerWrite {
  key: string
  dwarfId: DwarfId
  kind: AttentionKind
  suppressed: boolean
}

/** The double's "database": the `attention_keys` and `attention_announced` rows (09 §4.5). */
export class InMemoryAttentionRows {
  /** Claimed keys by key. */
  readonly keys = new Map<string, LedgerWrite>()
  /** `withdrawn_at` of the withdrawn keys. */
  readonly withdrawnAt = new Map<string, number>()
  /** Carry-over rows: pre-crash key by `carryOverKey(dwarfId, kind)`. */
  readonly announced = new Map<string, string>()
}

const CARRIED_KINDS: readonly CarriedKind[] = ['question', 'permission']

export class InMemoryAttentionLedger implements AttentionLedger {
  /** Every key this ledger claimed, in write order. */
  readonly writes: LedgerWrite[] = []

  constructor(
    readonly rows: InMemoryAttentionRows = new InMemoryAttentionRows(),
    private readonly clock: Clock = new FakeClock()
  ) {}

  emitted(): ReadonlySet<string> {
    return new Set(this.rows.keys.keys())
  }

  markEmitted(key: string, dwarfId: DwarfId, kind: AttentionKind): void {
    this.claim({ key, dwarfId, kind, suppressed: false })
  }

  markSuppressed(key: string, dwarfId: DwarfId, kind: AttentionKind): void {
    this.claim({ key, dwarfId, kind, suppressed: true })
  }

  carryOver(): ReadonlyMap<string, string> {
    return new Map(this.rows.announced)
  }

  consumeCarryOver(dwarfKind: string): void {
    this.rows.announced.delete(dwarfKind)
  }

  withdraw(keys: readonly string[]): readonly string[] {
    const now = this.clock.now()
    const newly: string[] = []
    for (const key of keys) {
      if (!this.rows.keys.has(key) || this.rows.withdrawnAt.has(key)) continue
      this.rows.withdrawnAt.set(key, now)
      newly.push(key)
    }
    return newly
  }

  sweepWithdrawn(before: number, limit: number): number {
    const due = [...this.rows.withdrawnAt]
      .filter(([, at]) => at < before)
      .slice(0, limit)
      .map(([key]) => key)
    for (const key of due) {
      this.rows.keys.delete(key)
      this.rows.withdrawnAt.delete(key)
    }
    return due.length
  }

  dropCarryOver(dwarfId: DwarfId): void {
    for (const kind of CARRIED_KINDS) this.rows.announced.delete(carryOverKey(dwarfId, kind))
  }

  /** A key is claimed once (`attention_keys.key` is the primary key, 09). */
  private claim(write: LedgerWrite): void {
    if (this.rows.keys.has(write.key)) {
      throw new Error(`attention key ${write.key} is already claimed`)
    }
    this.rows.keys.set(write.key, write)
    this.writes.push(write)
  }
}
