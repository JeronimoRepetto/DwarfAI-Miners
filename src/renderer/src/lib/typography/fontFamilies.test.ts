import { describe, expect, it } from 'vitest'
import { INTERFACE_FONTS, MESSAGING_FONTS } from '../../types'
import {
  INTERFACE_FONT_PROPERTY,
  MESSAGING_FONT_PROPERTY,
  fontFamilyLabel,
  fontFamilyReference
} from './fontFamilies'

/**
 * The one place a stored font identifier becomes something CSS can draw (#370).
 *
 * The identifier is what crosses the wire and lands in userData; the stack is a
 * design value and lives in design-tokens.css. This module is the join, and it
 * is a join rather than a second table because a stack spelled here as well
 * would be the drift `designTokens.test.ts` exists to prevent.
 */
describe('fontFamilyReference', () => {
  it.each([...INTERFACE_FONTS])('points %s at the token design-tokens.css declares', (font) => {
    expect(fontFamilyReference(font)).toBe(`var(--font-family-${font})`)
  })

  it('answers the same reference whichever role asked, so both can name one face', () => {
    // Picking the same family in both selectors is how the whole app becomes
    // one face; two tables would let that stop being true.
    for (const font of MESSAGING_FONTS) {
      expect(fontFamilyReference(font)).toBe(fontFamilyReference(font))
      expect(INTERFACE_FONTS).toContain(font)
    }
  })
})

describe('fontFamilyLabel', () => {
  it.each([
    ['tiny5', 'Tiny5'],
    ['pixelify-sans', 'Pixelify Sans'],
    ['roboto', 'Roboto'],
    ['arial', 'Arial']
  ] as const)('writes %s as the family name a person recognises, %s', (font, label) => {
    expect(fontFamilyLabel(font)).toBe(label)
  })

  it('has a label for every face Settings offers, so no segment can be blank', () => {
    for (const font of INTERFACE_FONTS) expect(fontFamilyLabel(font)).toBeTruthy()
  })
})

describe('the two role properties', () => {
  it('names the custom properties the stylesheet already paints with', () => {
    // Repointing the roles the components already read is what makes this one
    // composable instead of a change in every component.
    expect(INTERFACE_FONT_PROPERTY).toBe('--font-pixel')
    expect(MESSAGING_FONT_PROPERTY).toBe('--font-conversation')
  })
})
