// Driven port (05 §3.11, 16 §4.11): the emitted and suppressed attention keys and the carry-over
// rows (ADR-018 items 2–3), read and written inside the caller's transaction. `emitted()` holds
// every claimed key, suppressed ones included, so a suppressed key is never announced later
// (07 S17.08). `carryOver()` is keyed by `carryOverKey(dwarfId, kind)` (domain/carryOver.ts).
// `SqliteAttentionLedger` and `InMemoryAttentionLedger` run `runAttentionLedgerContract`.
import type { DwarfId } from '../../../kernel/domain/values'
import type { AttentionKind } from '../domain/decideLevel3'

export interface AttentionLedger {
  // emitted keys + carry-over (ADR-018 D2-D3)
  emitted(): ReadonlySet<string>
  markEmitted(key: string, dwarfId: DwarfId, kind: AttentionKind): void
  markSuppressed(key: string, dwarfId: DwarfId, kind: AttentionKind): void // decided, never shown (06 AttentionKey.suppressed; 07 S17.08: a turn-finished fact with no attached ui); the key is claimed so it is not announced later (09 attention_keys.suppressed = 1)
  carryOver(): ReadonlyMap<string, string>
  consumeCarryOver(dwarfKind: string): void
}
