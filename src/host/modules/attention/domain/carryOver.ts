// The carry-over of needs announced before a Host crash (ADR-018 item 3; ADR-015 item 5; 09
// `attention_announced`): one row per resumed dwarf and ask kind, holding the pre-crash key. The
// first re-raised ask of that dwarf and kind consumes it (07 S6.19). `AttentionLedger.carryOver()`
// keys its map by `carryOverKey` and `consumeCarryOver` takes the same string (16 §4.11 `dwarfKind`).
import type { DwarfId } from '../../../kernel/domain/values'
import type { AttentionFact, AttentionKind } from './decideLevel3'

/** The kinds a carry-over row can hold: asks only (09 `attention_announced.kind`). */
export type CarriedKind = Exclude<AttentionKind, 'turn-finished'>

/** The `dwarfKind` of 16 §4.11: `${dwarfId}:${kind}`, the prefix of that need's attention key. */
export function carryOverKey(dwarfId: DwarfId, kind: CarriedKind): string {
  return `${dwarfId}:${kind}`
}

/**
 * 07 S6.19 for a new fact: the first ask of a dwarf and kind that has a carry-over row is the need
 * re-raised after a silent resume. It is treated as already announced (`reannounce: false`, ADR-018
 * item 3) and linked to the pre-crash key it replaces, so the two are withdrawn together; the row
 * is consumed. A key already decided, a turn-finished fact and a fact with no row are unchanged.
 */
export function reRaisedFact(
  fact: AttentionFact,
  carried: ReadonlyMap<string, string>,
  emitted: ReadonlySet<string>
): { fact: AttentionFact; consumed?: string } {
  if (fact.kind === 'turn-finished' || emitted.has(fact.key)) return { fact }
  const consumed = carryOverKey(fact.dwarfId, fact.kind)
  const preCrashKey = carried.get(consumed)
  if (preCrashKey === undefined) return { fact }
  return {
    fact: { ...fact, reannounce: false, replacesKey: fact.replacesKey ?? preCrashKey },
    consumed
  }
}
