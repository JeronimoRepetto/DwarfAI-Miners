import { describe, expect, it } from 'vitest'
import { DWARF_NAME_MAX_GRAPHEMES, isResetOf, normalizeDwarfName } from './dwarfName'

// The `DwarfName` value object (06 §5.1; INV-29; US-MSG-005): what the Host stores as a dwarf's
// custom name, normalized again after UI main (NFR-SEC-08). TC-172-01.

/** The normalized name of `text`, or the refusal. */
function normalized(text: string): { name: string; dropped: boolean } | 'too-long' {
  const result = normalizeDwarfName(text)
  return result.ok ? result.value : result.error
}

/** An accented letter with no precomposed form: two code points, one grapheme even after NFC. */
const X_ACUTE = 'x́'

describe('DwarfName (INV-29)', () => {
  it('[US-MSG-005.AC07, INV-29] leading and trailing spaces are trimmed and every inner white-space run becomes one space', () => {
    for (const [text, name] of [
      ['  Watcher of seals  ', 'Watcher of seals'],
      ['Watcher   of\t\tseals', 'Watcher of seals'],
      ['\n Borin  the  Bold \r\n', 'Borin the Bold'],
      ['Gimli', 'Gimli']
    ] as const) {
      expect(normalized(text), JSON.stringify(text)).toStrictEqual({ name, dropped: false })
    }
  })

  it('[US-MSG-005.AC05] emoji and control characters are dropped and the result says so', () => {
    for (const [text, name] of [
      ['Gimli 🪓', 'Gimli'],
      ['👨‍👩‍👧 Ori', 'Ori'],
      ['🇦🇷Dori', 'Dori'],
      ['Nori 1️⃣', 'Nori'],
      ['Bo\u0007rin', 'Borin'],
      ['Nori‮', 'Nori'],
      ['Ba​lin', 'Balin'],
      ['🪓', '']
    ] as const) {
      expect(normalized(text), JSON.stringify(text)).toStrictEqual({ name, dropped: true })
    }
    // Accents, digits and other scripts are letters, not emoji: nothing is dropped.
    for (const text of ['Óin', 'Dwalin 2', 'Дорин', 'ドワーフ', 'Ëlva']) {
      expect(normalized(text), text).toStrictEqual({ name: text, dropped: false })
    }
  })

  it('[US-MSG-005.AC08] a name is at most 24 graphemes, an accented letter counting as one, and a 25th is refused', () => {
    expect(DWARF_NAME_MAX_GRAPHEMES).toBe(24)
    expect(normalized('a'.repeat(24))).toStrictEqual({ name: 'a'.repeat(24), dropped: false })
    expect(normalized('a'.repeat(25))).toBe('too-long')
    // Precomposed and decomposed é alike: one grapheme each, stored composed (NFC).
    expect(normalized('é'.repeat(24))).toStrictEqual({ name: 'é'.repeat(24), dropped: false })
    expect(normalized('é'.repeat(24))).toStrictEqual({
      name: 'é'.repeat(24),
      dropped: false
    })
    expect(normalized(X_ACUTE.repeat(24))).toStrictEqual({
      name: X_ACUTE.repeat(24),
      dropped: false
    })
    expect(normalized(X_ACUTE.repeat(25))).toBe('too-long')
    // The limit is on the normalized name: trimmed spaces and dropped emoji do not count.
    expect(normalized(`  ${'a'.repeat(24)}  🪓`)).toStrictEqual({
      name: 'a'.repeat(24),
      dropped: true
    })
  })

  it('[US-MSG-005.AC04] an empty text, or one equal to the base name after normalization, is a reset', () => {
    for (const text of ['', '   ', '\t\n', '🪓', 'Borin', '  Borin ', 'Bo\u0007rin', 'Borin 🪓']) {
      expect(isResetOf('Borin', text), JSON.stringify(text)).toBe(true)
    }
    for (const text of ['borin', 'Borin the Bold', 'Gimli', 'Bo rin']) {
      expect(isResetOf('Borin', text), JSON.stringify(text)).toBe(false)
    }
    expect(isResetOf('claude-0a1b2c3d', ' claude-0a1b2c3d ')).toBe(true)
  })
})
