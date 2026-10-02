import { describe, expect, it } from 'vitest'
import { COPY_LOCALES, DEFAULT_LOCALE, copyFor, en, formatList, t } from './index'

const MARKER = /^⟦COPY NEEDED: [^⟦⟧]+⟧$/

const valuesOf = (entry: (typeof en)[keyof typeof en]): string[] =>
  typeof entry === 'string' ? [entry] : Object.values(entry)

describe('the app copy dictionary', () => {
  it('keeps English as the default locale, and the only one so far', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(COPY_LOCALES).toEqual(['en'])
    expect(copyFor(['es-AR', 'de']).locale).toBe('en')
  })

  it('serves approved copy exactly, and a missing copy item as its whole marker', () => {
    expect(t('dialog.cancel')).toBe('Cancel')
    expect(t('hostState.crashLoop.text')).toBe('⟦COPY NEEDED: O-15 crash-loop variant⟧')
    expect(t('stopEverything.confirmation.count', { count: 2 })).toBe(
      '⟦COPY NEEDED: Stop everything and quit, 2 sessions DwarfAI started will end, singular, plural and zero forms (ADR-018 D5 copy item 5)⟧'
    )
    expect(formatList(['Ori', 'Nori'])).toBe('Ori, Nori')
  })

  it('never mixes a marker into other words: a value is a whole marker or holds none', () => {
    const values = Object.values(en).flatMap(valuesOf)
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      if (value.includes('⟦') || value.includes('⟧')) expect(value).toMatch(MARKER)
    }
  })

  it('[US-SHELL-010.AC03, US-SHELL-010.AC09] serves the PO #44 level-3 notification titles with the dwarf name as plain text', () => {
    expect(t('attention.level3Title.permission', { dwarf: 'Durin' })).toBe(
      'Durin asks for permission'
    )
    expect(t('attention.level3Title.question', { dwarf: 'Durin' })).toBe('Durin has a question')
    expect(t('attention.level3Title.turnFinished', { dwarf: 'Durin' })).toBe(
      'Durin finished the turn'
    )
  })
})
