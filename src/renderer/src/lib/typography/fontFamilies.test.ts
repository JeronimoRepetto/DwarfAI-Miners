import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TYPE_FACES, TYPE_ROLES, TYPE_ROLE_FACES } from '../../types'
import { fontFamilyLabel, fontFamilyReference } from './fontFamilies'

/**
 * The one place a stored font identifier becomes something CSS can draw (#370).
 *
 * The identifier is what crosses the wire and lands in userData; the stack is a
 * design value and lives in design-tokens.css. This module is the join, and it
 * is a join rather than a second table because a stack spelled here as well
 * would be the drift `designTokens.test.ts` exists to prevent.
 */
describe('fontFamilyReference', () => {
  // AMENDED (#635): was every interface face; now every face any role offers.
  it.each([...TYPE_FACES])('points %s at the token design-tokens.css declares', (font) => {
    expect(fontFamilyReference(font)).toBe(`var(--font-family-${font})`)
  })

  // AMENDED (#635): was "…whichever role asked, so both can name one face", over the two roles.
  it('answers the same reference whichever role asked, so every role can name one face', () => {
    // Picking the same family in every role is how the whole app becomes one face; a table per
    // role would let that stop being true.
    for (const role of TYPE_ROLES) {
      for (const font of TYPE_ROLE_FACES[role]) {
        expect(fontFamilyReference(font)).toBe(`var(--font-family-${font})`)
        expect(TYPE_FACES).toContain(font)
      }
    }
  })
})

describe('fontFamilyLabel', () => {
  it.each([
    ['tiny5', 'Tiny5'],
    ['pixelify-sans', 'Pixelify Sans'],
    ['roboto', 'Roboto'],
    ['arial', 'Arial'],
    ['jacquard-12', 'Jacquard 12']
  ] as const)('writes %s as the family name a person recognises, %s', (font, label) => {
    expect(fontFamilyLabel(font)).toBe(label)
  })

  // AMENDED (#635): was every interface face; a Custom select lists every face.
  it('has a label for every face Settings offers, so no option can be blank', () => {
    for (const font of TYPE_FACES) expect(fontFamilyLabel(font)).toBeTruthy()
  })
})

describe('the two role properties', () => {
  // AMENDED (#635): was "names the custom properties the stylesheet already paints with", when
  // useTypography repointed --font-pixel and --font-conversation itself. The four role tokens are
  // what a choice repoints now; the two #370 roles, still read by the pieces their slices have not
  // rebuilt, follow them from the stylesheet, so no component learns a preference exists.
  it('points the two #370 roles at the Labels and Messages roles in the stylesheet', () => {
    const css = readFileSync(join(import.meta.dirname, '../../assets/design-tokens.css'), 'utf8')
    expect(css).toMatch(/--font-pixel:\s*var\(--f-label\);/)
    expect(css).toMatch(/--font-conversation:\s*var\(--f-talk\);/)
  })
})
