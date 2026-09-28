import { describe, expect, it } from 'vitest'
import {
  DWARF_NAME_MAX,
  cleanDwarfName,
  customNameFor,
  filterDwarfName,
  nameChars
} from './dwarfName'

/*
 * The rules are the design's (screens/message.md, "What is saved"; decision log, Dwarf names), and
 * the reference is the prototype's DM.cleanDwarfName in sample-data.md: emoji and control
 * characters removed, trimmed, inner white space collapsed to one space, at most 24 characters as a
 * person counts them. Every case below names the rule it holds.
 */
describe('cleanDwarfName (#635, Dwarf names)', () => {
  it('keeps an ordinary name exactly as typed', () => {
    expect(cleanDwarfName('Gimli')).toBe('Gimli')
  })

  it('trims white space at either end', () => {
    expect(cleanDwarfName('   Gimli  ')).toBe('Gimli')
  })

  it('makes every run of white space inside the name one space', () => {
    expect(cleanDwarfName('Gimli    son  of Glóin')).toBe('Gimli son of Glóin')
  })

  it('reads a tab or a line break as white space, never as part of the name', () => {
    expect(cleanDwarfName('Gimli\t\tson\r\nof\nGlóin')).toBe('Gimli son of Glóin')
  })

  // The prototype turns a control character into a space before anything else, so one that sat
  // between two words still separates them rather than gluing them together.
  it('drops control characters, leaving a space where one separated two words', () => {
    expect(cleanDwarfName('Gim\u0000li')).toBe('Gim li')
    expect(cleanDwarfName('\u0007Gimli\u001b')).toBe('Gimli')
    expect(cleanDwarfName('Gimli\u0085Glóin')).toBe('Gimli Glóin')
    expect(cleanDwarfName('Gimli\u2028Glóin\u2029')).toBe('Gimli Glóin')
    expect(cleanDwarfName('Gimli\u007f')).toBe('Gimli')
  })

  it('drops a character drawn as an emoji by default', () => {
    expect(cleanDwarfName('Gimli 😀')).toBe('Gimli')
    expect(cleanDwarfName('⌛Gimli🚀')).toBe('Gimli')
  })

  it('drops a whole joined emoji, joiner and all', () => {
    expect(cleanDwarfName('Gimli 👨‍👩‍👧')).toBe('Gimli')
  })

  it('drops a skin tone with the emoji it tints', () => {
    expect(cleanDwarfName('Gimli 👍🏽')).toBe('Gimli')
  })

  it('drops a flag, which is two regional indicators', () => {
    expect(cleanDwarfName('Gimli 🇦🇷')).toBe('Gimli')
  })

  it('drops the tag characters of a subdivision flag with the flag itself', () => {
    expect(cleanDwarfName('Gimli 🏴󠁧󠁢󠁳󠁣󠁴󠁿')).toBe('Gimli')
  })

  // A keycap is a plain digit or sign, VS16 and the enclosing keycap mark: the pieces go, and the
  // text character they were built on stays, because it is not an emoji by default.
  it('drops a keycap and a variation selector, keeping the text character under them', () => {
    expect(cleanDwarfName('Gimli 1️⃣')).toBe('Gimli 1')
    expect(cleanDwarfName('Gimli ©️')).toBe('Gimli ©')
  })

  it('drops a lone zero-width joiner', () => {
    expect(cleanDwarfName('Gim\u200dli')).toBe('Gimli')
  })

  it('keeps letters with their accents, from any script', () => {
    expect(cleanDwarfName('Óðinn Þórsson')).toBe('Óðinn Þórsson')
    expect(cleanDwarfName('ドワーフ')).toBe('ドワーフ')
  })

  it('keeps at most 24 characters', () => {
    expect(cleanDwarfName('a'.repeat(30))).toBe('a'.repeat(24))
    expect(cleanDwarfName('a'.repeat(24))).toBe('a'.repeat(24))
  })

  // A letter with a combining accent is two code points and one character as a person counts it.
  it('counts a letter and its combining accent as one character', () => {
    const accented = 'e\u0301'
    expect(cleanDwarfName(accented.repeat(30))).toBe(accented.repeat(24))
  })

  it('counts an astral letter as one character', () => {
    const letter = '𐌰'
    expect(cleanDwarfName(letter.repeat(25))).toBe(letter.repeat(24))
  })

  it('leaves nothing when nothing but white space, emoji or control characters was typed', () => {
    expect(cleanDwarfName('')).toBe('')
    expect(cleanDwarfName('    ')).toBe('')
    expect(cleanDwarfName('😀 🇦🇷')).toBe('')
    expect(cleanDwarfName('\u0000\u0001')).toBe('')
  })

  it('is 24 by the design', () => {
    expect(DWARF_NAME_MAX).toBe(24)
  })
})

describe('filterDwarfName (#635) — what the field lets through while typing', () => {
  it('lets an ordinary name through and refuses nothing', () => {
    expect(filterDwarfName('Gimli ')).toEqual({ text: 'Gimli ', refused: null })
  })

  it('says it dropped characters when an emoji or a control character was typed', () => {
    expect(filterDwarfName('Gim😀li')).toEqual({ text: 'Gimli', refused: 'chars' })
    expect(filterDwarfName('Gim\u0000li')).toEqual({ text: 'Gimli', refused: 'chars' })
  })

  it('says it was too long when it cut the text at 24 characters', () => {
    expect(filterDwarfName('b'.repeat(25))).toEqual({ text: 'b'.repeat(24), refused: 'long' })
  })

  it('names the dropped characters first when both happened', () => {
    expect(filterDwarfName('😀' + 'b'.repeat(25))).toEqual({
      text: 'b'.repeat(24),
      refused: 'chars'
    })
  })
})

describe('nameChars (#635)', () => {
  it('splits a name into characters as a person counts them', () => {
    expect(nameChars('Ge\u0301mli')).toEqual(['G', 'e\u0301', 'm', 'l', 'i'])
  })
})

/*
 * The one decision DM.setDwarfName makes before it keeps anything: the cleaned text becomes the
 * custom name, unless it is empty or equal to the base name, which removes the custom name.
 */
describe('customNameFor (#635)', () => {
  it('keeps the cleaned text as the custom name', () => {
    expect(customNameFor('  Stonebeard  ', 'Explorer')).toBe('Stonebeard')
  })

  it('removes the custom name when the cleaned text is empty', () => {
    expect(customNameFor('   ', 'Explorer')).toBeUndefined()
    expect(customNameFor('😀', 'Explorer')).toBeUndefined()
  })

  it('removes the custom name when the cleaned text is the base name', () => {
    expect(customNameFor('Explorer', 'Explorer')).toBeUndefined()
    expect(customNameFor('  Explorer ', 'Explorer')).toBeUndefined()
  })

  it('keeps a name that differs from the base name only in case', () => {
    expect(customNameFor('explorer', 'Explorer')).toBe('explorer')
  })
})
