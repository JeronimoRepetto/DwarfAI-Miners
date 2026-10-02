import { describe, expect, expectTypeOf, it } from 'vitest'
import { createCopy, resolveLocale, type CopyCatalog } from './catalog'

/** A small catalog of its own, so the engine is tested apart from the app's copy. */
const base = {
  'greeting.plain': 'Hello',
  'greeting.named': 'Hello, {name}',
  'greeting.two': '{a} and {b}',
  'mines.count': { '=0': 'No mines', one: '{count} mine', other: '{count} mines' },
  'only.base': 'Base only'
} as const satisfies CopyCatalog

const fallback = { locale: 'en', catalog: base }

const english = createCopy({ locale: 'en', fallback })

describe('createCopy', () => {
  it('looks up the text of a key', () => {
    expect(english.t('greeting.plain')).toBe('Hello')
  })

  it('[R19] fills a slot with the value as plain text, never as markup or a second template', () => {
    const value = '<b onclick="x()">{b}</b> $& $1'
    expect(english.t('greeting.named', { name: value })).toBe(`Hello, ${value}`)
    expect(english.t('greeting.two', { a: '{b}', b: 2 })).toBe('{b} and 2')
  })

  it('picks the plural form with Intl.PluralRules, an exact =0 first', () => {
    expect(english.t('mines.count', { count: 0 })).toBe('No mines')
    expect(english.t('mines.count', { count: 1 })).toBe('1 mine')
    expect(english.t('mines.count', { count: 2 })).toBe('2 mines')
  })

  it("uses the locale's own plural rules for its own entry", () => {
    const polish = createCopy({
      locale: 'pl',
      fallback,
      catalogs: {
        pl: {
          'mines.count': {
            one: '{count} kopalnia',
            few: '{count} kopalnie',
            other: '{count} kopalń'
          }
        }
      }
    })
    expect(polish.t('mines.count', { count: 1 })).toBe('1 kopalnia')
    expect(polish.t('mines.count', { count: 3 })).toBe('3 kopalnie')
    expect(polish.t('mines.count', { count: 5 })).toBe('5 kopalń')
    // `=0` is not a form of this entry, so zero takes its Polish category.
    expect(polish.t('mines.count', { count: 0 })).toBe('0 kopalń')
  })

  it('falls back to the fallback catalog, with its plural rules, for a key the locale lacks', () => {
    const spanish = createCopy({
      locale: 'es',
      fallback,
      catalogs: { es: { 'greeting.plain': 'Hola' } }
    })
    expect(spanish.t('greeting.plain')).toBe('Hola')
    expect(spanish.t('only.base')).toBe('Base only')
    expect(spanish.t('mines.count', { count: 1 })).toBe('1 mine')
  })

  it('falls back to the fallback catalog for a locale with no catalog at all', () => {
    const french = createCopy({ locale: 'fr', fallback })
    expect(french.t('greeting.named', { name: 'Ana' })).toBe('Hello, Ana')
  })

  it("joins names as a list in the locale's own way", () => {
    expect(english.list([])).toBe('')
    expect(english.list(['Ori'])).toBe('Ori')
    expect(english.list(['Ori', 'Nori', 'Dori'])).toBe('Ori, Nori, Dori')
  })

  it('checks keys and slots at compile time', () => {
    // @ts-expect-error a key that is not in the catalog is a type error
    english.t('greeting.missing')
    // @ts-expect-error a value with a slot needs its params
    english.t('greeting.named')
    // @ts-expect-error every slot is required
    english.t('greeting.two', { a: 'x' })
    // @ts-expect-error a slot the value does not have is a type error
    english.t('greeting.named', { nme: 'Ana' })
    // @ts-expect-error a value without slots takes no params
    english.t('greeting.plain', { name: 'Ana' })
    // @ts-expect-error a plural entry needs a numeric count
    english.t('mines.count', { count: '1' })
    expectTypeOf(english.t<'greeting.named'>)
      .parameter(1)
      .toEqualTypeOf<{ readonly name: string | number }>()
    expectTypeOf(english.t<'mines.count'>)
      .parameter(1)
      .toEqualTypeOf<{ readonly count: number }>()
  })
})

describe('resolveLocale', () => {
  const supported = ['en', 'es'] as const

  it('takes the first preferred tag the app has, by exact tag or by its language', () => {
    expect(resolveLocale(['fr-FR', 'es-AR', 'en'], supported, 'en')).toBe('es')
    expect(resolveLocale(['EN-gb'], supported, 'en')).toBe('en')
    expect(resolveLocale(['es'], supported, 'en')).toBe('es')
  })

  it('falls back when no preferred tag is supported, or none is given', () => {
    expect(resolveLocale(['fr-FR', 'de'], supported, 'en')).toBe('en')
    expect(resolveLocale([], supported, 'en')).toBe('en')
    expect(resolveLocale(['', 'not a tag'], supported, 'en')).toBe('en')
  })
})
