import { describe, expect, it } from 'vitest'
import { removeFailureNotice } from './removeMine'

/**
 * What the panel says about a finished removal (#169), the sibling of
 * addProject.ts's `declareFailureNotice` and deliberately the same shape: main
 * owns the verdict, and the only judgement here is what is worth saying out
 * loud.
 */
describe('removeFailureNotice', () => {
  it('says nothing at all when the mine was removed', () => {
    // The list is the feedback: the card is gone. A notice about a success
    // would be a message the user has to dismiss for having got what they
    // asked for.
    expect(removeFailureNotice({ outcome: 'removed' })).toBeNull()
  })

  it('carries main’s reason when the store refused', () => {
    expect(removeFailureNotice({ outcome: 'failed', reason: 'The database is locked.' })).toBe(
      'The database is locked.'
    )
  })

  it('says something for a refusal that arrived with no reason', () => {
    // The contract does not allow it, but a control that reports nothing at
    // all reads as broken rather than as declined.
    expect(removeFailureNotice({ outcome: 'failed' })).toBeTruthy()
  })

  it('speaks up for a mine the app was not tracking, rather than claiming a removal', () => {
    // 'unchanged' is not a success: nothing was removed. The card is on screen
    // because the panel believes the mine exists, so silence here would leave
    // it there with no explanation.
    expect(removeFailureNotice({ outcome: 'unchanged', reason: 'Not tracked.' })).toBe(
      'Not tracked.'
    )
  })
})
