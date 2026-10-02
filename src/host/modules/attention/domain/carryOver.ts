// The carry-over of needs announced before a Host crash (ADR-018 item 3; ADR-015 item 5; 09
// `attention_announced`): one row per resumed dwarf and ask kind, holding the pre-crash key. The
// first re-raised ask of that dwarf and kind consumes it (07 S6.19). `AttentionLedger.carryOver()`
// keys its map by `carryOverKey` and `consumeCarryOver` takes the same string (16 §4.11 `dwarfKind`).
import type { DwarfId } from '../../../kernel/domain/values'
import type { AttentionKind } from './decideLevel3'

/** The kinds a carry-over row can hold: asks only (09 `attention_announced.kind`). */
export type CarriedKind = Exclude<AttentionKind, 'turn-finished'>

/** The `dwarfKind` of 16 §4.11: `${dwarfId}:${kind}`, the prefix of that need's attention key. */
export function carryOverKey(dwarfId: DwarfId, kind: CarriedKind): string {
  return `${dwarfId}:${kind}`
}
