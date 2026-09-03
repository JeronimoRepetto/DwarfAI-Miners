import { describe, expect, it } from 'vitest'
import { declareFailureNotice } from './addProject'

// The test pinning the old exact-sentence bridge — "treats a refusal it does
// not recognise as a failure, never as a cancel" — went with PICKER_CANCELLED_REASON
// itself when #127 gave MineDeclareResult the `outcome` discriminator its
// sibling already had. There is no longer a sentence to mismatch: `outcome` is
// a closed union of three literals, so an "unrecognised" refusal cannot arrive
// on the wire at all, and the case this test guarded against does not exist
// anymore. The two outcomes it split apart are covered below instead, directly.
describe('declareFailureNotice', () => {
  it('has nothing to say when the folder was adopted', () => {
    expect(declareFailureNotice({ outcome: 'added', mineId: 'C:/dev/alpha' })).toBeNull()
  })

  it('says nothing when the user simply closed the picker', () => {
    // Backing out of a folder picker is a decision, not a fault, and a notice
    // for it would scold the user for changing their mind.
    expect(declareFailureNotice({ outcome: 'cancelled' })).toBeNull()
  })

  it('states why the folder could not be added', () => {
    expect(
      declareFailureNotice({
        outcome: 'failed',
        reason: 'That folder could not be saved as a mine.'
      })
    ).toBe('That folder could not be saved as a mine.')
  })

  it('still says something when a refusal carries no reason', () => {
    // A button that sometimes does nothing at all reads as broken rather than
    // as declined, which is the whole reason main states every refusal.
    expect(declareFailureNotice({ outcome: 'failed' })).toBeTruthy()
  })
})
