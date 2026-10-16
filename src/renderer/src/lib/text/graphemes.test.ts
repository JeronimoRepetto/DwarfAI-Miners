import { describe, expect, it } from 'vitest'
import { graphemeClusters, trimGraphemes } from './graphemes'

/*
 * One character is one grapheme cluster (US-MSG-012.AC07): the counting the outcome line's tooltip
 * trims by, the same the app counts a custom dwarf name by.
 */
const DECOMPOSED_E = 'e\u0301' // "é" as a letter and a combining acute: two code points
const FLAG = '\u{1F1E6}\u{1F1F7}' // a flag: two regional indicators
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}' // an emoji family: five code points

describe('graphemeClusters', () => {
  it('[US-MSG-012.AC07] counts a decomposed accented letter, a flag and an emoji family as one character each', () => {
    expect(graphemeClusters('a' + DECOMPOSED_E + FLAG + FAMILY)).toEqual([
      'a',
      DECOMPOSED_E,
      FLAG,
      FAMILY
    ])
    expect(graphemeClusters('')).toEqual([])
  })
})

describe('trimGraphemes', () => {
  it('[US-MSG-012.AC07] keeps text of the limit or fewer whole, and cuts longer text after the limit with an ellipsis', () => {
    expect(trimGraphemes(DECOMPOSED_E.repeat(3), 3)).toBe(DECOMPOSED_E.repeat(3))
    expect(trimGraphemes(DECOMPOSED_E.repeat(4), 3)).toBe(DECOMPOSED_E.repeat(3) + '…')
    expect(trimGraphemes(FAMILY + FLAG + 'x', 2)).toBe(FAMILY + FLAG + '…')
  })
})
