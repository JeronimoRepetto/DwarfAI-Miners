// The message log's storage cap (06 INV-61; ADR-007 item 5 as decided by PO #87 / Q10; 09 §5.2
// step 3, §7.1). Pure: no I/O, no clock read (05 §2.2, R1).

/** At most this many stored rows per dwarf, every role counted. A constant, never a setting. */
export const MESSAGES_PER_DWARF = 50

/** What the rule reads of one stored row of a dwarf. */
export interface RetainedRow {
  id: string
  /** `messages.sort_at`: the provider time, else the row's `created_at`. */
  sortAt: number
  /** The row's delivery is `sending` (a row still being handed over). */
  sending: boolean
}

/**
 * The ids of a dwarf's rows that the cap removes: the rows ranked after the first
 * `MESSAGES_PER_DWARF` when `sending` rows rank first, then newest by `sortAt`, then by `id`
 * (09 §5.2 step 3). The cap is literal: it is never exceeded to keep a row (lead decision R4B-10).
 */
export function rowsToTrim(rows: readonly RetainedRow[]): string[] {
  return [...rows]
    .sort(retainedFirst)
    .slice(MESSAGES_PER_DWARF)
    .map((r) => r.id)
}

/** 09 §5.2 step 3 order: `sending` first, then `sort_at DESC, id DESC`. */
function retainedFirst(a: RetainedRow, b: RetainedRow): number {
  if (a.sending !== b.sending) return a.sending ? -1 : 1
  return b.sortAt - a.sortAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0)
}
