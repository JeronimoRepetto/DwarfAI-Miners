import { describe, expect, it } from 'vitest'
import { isValidResetConfirmation } from './resetConfirmation'

/**
 * Settings' reset-metrics modal (#138): "Confirm" starts disabled and uses the
 * enabled style only once the typed text is a valid confirmation.
 *
 * The design states the user types `Yes`/`yes` but the PDF does not define
 * case sensitivity (screens/settings.md, components.md). DECISION (#138):
 * accept case-insensitive, trimmed 'yes' — trimmed because a stray leading or
 * trailing space is a typing accident, not a different answer, and
 * case-insensitive because the PDF shows both cases as valid examples without
 * choosing between them.
 */
describe('isValidResetConfirmation', () => {
  it.each(['yes', 'Yes', 'YES', 'yEs'])('accepts %s in any letter case', (value) => {
    expect(isValidResetConfirmation(value)).toBe(true)
  })

  it.each([' yes', 'yes ', '  Yes  '])(
    'accepts %s with surrounding whitespace trimmed',
    (value) => {
      expect(isValidResetConfirmation(value)).toBe(true)
    }
  )

  it('rejects the empty string', () => {
    expect(isValidResetConfirmation('')).toBe(false)
  })

  it('rejects whitespace-only input', () => {
    expect(isValidResetConfirmation('   ')).toBe(false)
  })

  it.each(['ye', 'yess', 'no', 'y', 'yes please'])(
    'rejects anything but exactly "yes" (%s)',
    (value) => {
      expect(isValidResetConfirmation(value)).toBe(false)
    }
  )
})
