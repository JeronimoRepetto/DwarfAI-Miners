import { describe, expect, it } from 'vitest'
import { PICKER_CANCELLED_REASON, declareFailureNotice } from './addProject'

describe('declareFailureNotice', () => {
  it('has nothing to say when the folder was adopted', () => {
    expect(declareFailureNotice({ declared: true, mineId: 'C:/dev/alpha' })).toBeNull()
  })

  it('says nothing when the user simply closed the picker', () => {
    // Backing out of a folder picker is a decision, not a fault, and a notice
    // for it would scold the user for changing their mind.
    expect(declareFailureNotice({ declared: false, reason: PICKER_CANCELLED_REASON })).toBeNull()
  })

  it('states why the folder could not be added', () => {
    expect(
      declareFailureNotice({
        declared: false,
        reason: 'That folder could not be saved as a mine.'
      })
    ).toBe('That folder could not be saved as a mine.')
  })

  it('still says something when a refusal carries no reason', () => {
    // A button that sometimes does nothing at all reads as broken rather than
    // as declined, which is the whole reason main states every refusal.
    expect(declareFailureNotice({ declared: false })).toBeTruthy()
  })

  it('treats a refusal it does not recognise as a failure, never as a cancel', () => {
    // The wire carries no cancelled/failed flag, so this match is on the exact
    // sentence main sends. It has to fail towards SHOWING: a reworded cancel
    // becoming a visible notice is noise, while an unrecognised real failure
    // being swallowed is the button silently doing nothing.
    expect(declareFailureNotice({ declared: false, reason: 'no folder was chosen' })).toBe(
      'no folder was chosen'
    )
  })
})
