// The copy dictionary (owner rule 2026-10-02): every user-visible string of the renderer and of UI main is looked up
// here by key, so a change of language, or a second language, is one catalog away. It lives in `contracts/` because
// that is the only code both UI trees may import (05 §2.1; R8 lets the renderer import contracts, R10 keeps the trees
// apart, R9 keeps this folder self-contained), and in `text/`, the pure text folder, because 05 §2.1's folder list is
// normative. Import it from `@dwarfai/contracts`. Built in house: no i18n dependency.
//
// How to add a string:
// 1. Add a key to `en.ts`, namespaced by feature (`<feature>.<part>.<role>`, e.g. `hostState.crashLoop.title`). Its
//    value is the approved copy exactly, or the `⟦COPY NEEDED: <design item>⟧` marker when design has not written it
//    (never invented text).
// 2. A value that carries data names a `{slot}`; `t('key', { slot: value })` fills it as plain text, and the type
//    requires every slot. A count that changes the words is a plural entry (`{ '=0'?, one?, …, other }`): `t` picks
//    the form with `Intl.PluralRules` and requires `{ count }`.
// 3. Look it up with `t('key')` where the text is shown, never a string literal in a component or a menu builder.
//    A key that is not in `en.ts` is a type error.
// 4. Another locale is a `Partial` catalog added to `CATALOGS` and `COPY_LOCALES`; a key it lacks falls back to `en`.
import { createCopy, resolveLocale, type CopyEntry, type PlainKey } from './catalog'
import { en } from './en'

export type {
  Copy,
  CopyArgs,
  CopyCatalog,
  CopyEntry,
  CopyOptions,
  PlainKey,
  PluralForms,
  Translate
} from './catalog'
export { createCopy, resolveLocale } from './catalog'
export { en } from './en'

/** The locales the app has a catalog for; `en` is the default and the fallback for every missing key. */
export const COPY_LOCALES = ['en'] as const
export type CopyLocale = (typeof COPY_LOCALES)[number]
export const DEFAULT_LOCALE: CopyLocale = 'en'

/** A key of the copy dictionary. */
export type CopyKey = keyof typeof en

/** The catalogs of the locales other than `en`, each partial: none yet. */
const CATALOGS: Readonly<Partial<Record<CopyLocale, Partial<Record<CopyKey, CopyEntry>>>>> = {}

/** A key of the copy dictionary whose text takes no params. */
export type PlainCopyKey = PlainKey<typeof en>

/**
 * The copy for the person's preferred languages (BCP 47 tags, most preferred first). Nothing chooses a language yet,
 * so the app uses `t` below, which is the default locale.
 */
export function copyFor(preferred: readonly string[]) {
  return createCopy({
    locale: resolveLocale(preferred, COPY_LOCALES, DEFAULT_LOCALE),
    fallback: { locale: DEFAULT_LOCALE, catalog: en },
    catalogs: CATALOGS
  })
}

const appCopy = copyFor([DEFAULT_LOCALE])

/** Looks up the copy for `key` in the app's locale, filling its `{slots}` as plain text. */
export const t = appCopy.t

/** Joins names as a list in the app's locale (`a, b, c` in English). */
export const formatList = appCopy.list
