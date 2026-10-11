import { describe, expect, it } from 'vitest'
import { COPY_LOCALES, DEFAULT_LOCALE, copyFor, en, formatList, t } from './index'

const valuesOf = (entry: (typeof en)[keyof typeof en]): string[] =>
  typeof entry === 'string' ? [entry] : Object.values(entry)

describe('the app copy dictionary', () => {
  it('keeps English as the default locale, and the only one so far', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(COPY_LOCALES).toEqual(['en'])
    expect(copyFor(['es-AR', 'de']).locale).toBe('en')
  })

  it('serves approved copy exactly', () => {
    expect(t('dialog.cancel')).toBe('Cancel')
    expect(t('hostState.crashLoop.text')).toBe(
      'The part of DwarfAI-Miners that runs your dwarfs stopped several times in a few minutes, so it is no longer restarted on its own. The panel is read-only until it runs again.'
    )
    expect(t('stopEverything.confirmation.count', { count: 2 })).toBe(
      '2 dwarfs started by DwarfAI-Miners will stop.'
    )
    expect(formatList(['Ori', 'Nori'])).toBe('Ori, Nori')
  })

  it('serves the Stop everything and quit button in its zero, singular and plural forms', () => {
    expect(t('stopEverything.confirmation.confirm', { count: 0 })).toBe('Stop everything and quit')
    expect(t('stopEverything.confirmation.confirm', { count: 1 })).toBe('Stop 1 dwarf and quit')
    expect(t('stopEverything.confirmation.confirm', { count: 3 })).toBe('Stop 3 dwarfs and quit')
  })

  it('ships no placeholder: no value of the catalog holds a COPY NEEDED marker', () => {
    const values = Object.values(en).flatMap(valuesOf)
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      expect(value).not.toContain('⟦')
      expect(value).not.toContain('⟧')
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
