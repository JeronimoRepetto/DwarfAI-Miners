// Driven port (05 §3.11, 16 §4.11): the emitted and suppressed attention keys and the carry-over
// rows (ADR-018 items 2–4), read and written inside the caller's transaction. `emitted()` holds
// every claimed key, suppressed and withdrawn ones included, so a decided key is never announced
// later (INV-100, 07 S17.08). `carryOver()` is keyed by `carryOverKey(dwarfId, kind)`
// (domain/carryOver.ts). `SqliteAttentionLedger` and `InMemoryAttentionLedger` run
// `runAttentionLedgerContract`.
//
// "Amendment for frozen 16 §4.11 AttentionLedger" (owner-approved 2026-10-02, ISSUE-110) adds
// `withdraw`, `sweepWithdrawn` and `dropCarryOver`: the `onFactEnded` row writes
// `attention_keys.withdrawn_at`, and 09 §7.1 deletes withdrawn keys after 24 h and a dwarf's
// carry-over rows on a person-initiated turn or its departure.
import type { DwarfId } from '../../../kernel/domain/values'
import type { AttentionKind } from '../domain/decideLevel3'

export interface AttentionLedger {
  // emitted keys + carry-over (ADR-018 D2-D3)
  emitted(): ReadonlySet<string>
  markEmitted(key: string, dwarfId: DwarfId, kind: AttentionKind): void
  markSuppressed(key: string, dwarfId: DwarfId, kind: AttentionKind): void // decided, never shown (06 AttentionKey.suppressed; 07 S17.08: a turn-finished fact with no attached ui); the key is claimed so it is not announced later (09 attention_keys.suppressed = 1)
  carryOver(): ReadonlyMap<string, string>
  consumeCarryOver(dwarfKind: string): void
  withdraw(keys: readonly string[]): readonly string[] // ADR-018 D4: sets withdrawn_at once on claimed keys; returns the keys newly withdrawn (AMENDMENT, ISSUE-110)
  sweepWithdrawn(before: number, limit: number): number // 09 §7.1: deletes at most `limit` keys withdrawn before `before`; returns how many (AMENDMENT, ISSUE-110)
  dropCarryOver(dwarfId: DwarfId): void // 09 §7.1: the dwarf's carry-over rows, on a person-initiated turn or departure (AMENDMENT, ISSUE-110)
}
