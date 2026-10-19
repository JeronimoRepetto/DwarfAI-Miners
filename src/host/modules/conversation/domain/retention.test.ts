import { describe, expect, it } from 'vitest'
import { MESSAGES_PER_DWARF, rowsToTrim, type RetainedRow } from './retention'

// L1 (17 §1.1): the storage cap of 09 §5.2 step 3 as a pure rule.
const row = (n: number, sending = false): RetainedRow => ({
  id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  sortAt: 1_790_000_000_000 + n,
  sending
})

describe('rowsToTrim', () => {
  it('[INV-61] of 51 rows the oldest is trimmed, and a sending row is kept even when it is the oldest', () => {
    const rows = Array.from({ length: 51 }, (_, n) => row(n))

    expect(MESSAGES_PER_DWARF).toBe(50)
    expect(rowsToTrim(rows)).toEqual([row(0).id])
    // The oldest row is still being handed over: the oldest row that is not goes instead.
    const withSending = [row(0, true), ...rows.slice(1)]
    expect(rowsToTrim(withSending)).toEqual([row(1).id])
    // Equal sort times fall back to the id, newest id kept.
    const tied = [...rows.slice(2), { ...row(1), sortAt: row(2).sortAt }, row(0, true)]
    expect(rowsToTrim(tied)).toEqual([row(1).id])
    // 50 rows or fewer: nothing goes.
    expect(rowsToTrim(rows.slice(1))).toEqual([])
  })
})
