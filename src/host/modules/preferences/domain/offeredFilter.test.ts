import { describe, expect, it } from 'vitest'
import { OFFERED_FILTER } from './offeredFilter'

// L1: the strangler-only per-cut filter of `WelcomeStepState.offered` (21 §2 cut 2; AMENDMENT-9,
// OQ-70) is data with its removal cut, so the issue that removes it deletes it in one place.
describe('offered filter (21 §2 cut 2)', () => {
  it('[US-SET-012.AC07, ADR-016] in cuts 2 to 3e only the Claude Code option is offered, and the filter names the cut that removes it', () => {
    expect(OFFERED_FILTER).toStrictEqual({
      offered: ['claude-hooks'],
      removedInCut: '4a',
      removedBy: 'ISSUE-232'
    })
    expect(Object.isFrozen(OFFERED_FILTER)).toBe(true)
    expect(Object.isFrozen(OFFERED_FILTER.offered)).toBe(true)
  })
})
