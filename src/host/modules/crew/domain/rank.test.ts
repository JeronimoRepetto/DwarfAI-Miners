import { describe, expect, it } from 'vitest'
import { rankForDepth } from './rank'

// Rank by depth below the dwarf's root session (06 §5.1 `DwarfRank`, INV-27; PO #21).
describe('rankForDepth (06 §5.1, INV-27)', () => {
  it('[US-OBS-008.AC01, INV-27] a root session is ranked foreman', () => {
    // The subagent is seen before its root: the rank still comes from depth alone, never from
    // the order of arrival or from whether the root ever coordinated anyone (today's latch).
    const subagentFirst = rankForDepth(1)
    const rootAfterIt = rankForDepth(0)
    expect(subagentFirst).toBe('worker')
    expect(rootAfterIt).toBe('foreman')
    expect(rankForDepth(0)).toBe('foreman')
  })

  it('[US-OBS-008.AC02] a subagent of a foreman is ranked worker', () => {
    expect(rankForDepth(1)).toBe('worker')
  })

  it('[US-OBS-008.AC03] a subagent of a worker is ranked worker2', () => {
    expect(rankForDepth(2)).toBe('worker2')
  })

  it('[US-OBS-008.AC04] a subagent at depth three or more is still ranked worker2', () => {
    expect(rankForDepth(3)).toBe('worker2')
    expect(rankForDepth(5)).toBe('worker2')
    expect(rankForDepth(42)).toBe('worker2')
  })

  it('[INV-27] depths 0, 1, 2 and 5 rank foreman, worker, worker2, worker2 and an unknown depth reads as worker', () => {
    expect([0, 1, 2, 5].map(rankForDepth)).toEqual(['foreman', 'worker', 'worker2', 'worker2'])
    expect(rankForDepth(null)).toBe('worker')
  })
})
