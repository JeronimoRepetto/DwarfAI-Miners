// The copy dictionary's engine: catalog types, the typed lookup and the locale resolver. Pure, no I/O; `Intl` is the
// only platform API it reads, and both UI trees have it.

/** A plural entry: one string per form. `=0` is an exact zero; the rest are `Intl.PluralRules` categories. */
export type PluralForms = { readonly other: string } & {
  readonly [form in Exclude<Intl.LDMLPluralRule, 'other'> | '=0']?: string
}

export type CopyEntry = string | PluralForms

export type CopyCatalog = Readonly<Record<string, CopyEntry>>

/** The `{slot}` names a text carries. */
type SlotsOf<S extends string> = S extends `${string}{${infer Slot}}${infer Rest}`
  ? Slot | SlotsOf<Rest>
  : never

/** Every text of an entry: the string itself, or each of its plural forms. */
type TextsOf<E extends CopyEntry> = E extends string ? E : Extract<E[keyof E], string>

/**
 * What `t` takes for an entry: nothing without slots; every slot otherwise, and a numeric `count` for a plural. Not
 * distributive: a key that may be one of several entries needs the params of every one of them.
 */
export type CopyArgs<E extends CopyEntry> = [E] extends [string]
  ? [SlotsOf<E>] extends [never]
    ? []
    : [params: { readonly [Slot in SlotsOf<E>]: string | number }]
  : [
      params: {
        readonly [Slot in SlotsOf<TextsOf<E>> | 'count']: Slot extends 'count'
          ? number
          : string | number
      }
    ]

/** The keys of a catalog whose entry takes no params: a table of them can be looked up with `t(key)` alone. */
export type PlainKey<C extends CopyCatalog> = {
  [K in keyof C & string]: CopyArgs<C[K]> extends [] ? K : never
}[keyof C & string]

/** The lookup: a key of the catalog, and the params its entry needs. A key not in the catalog is a type error. */
export type Translate<C extends CopyCatalog> = <K extends keyof C & string>(
  key: K,
  ...args: CopyArgs<C[K]>
) => string

export interface Copy<C extends CopyCatalog> {
  /** The locale this copy speaks. */
  readonly locale: string
  readonly t: Translate<C>
  /** Joins items (names, for example) as a list in the locale's own way, with no conjunction. */
  list(items: readonly string[]): string
}

export interface CopyOptions<C extends CopyCatalog> {
  /** The locale to speak, already resolved (`resolveLocale`). */
  locale: string
  /** The complete catalog and its locale: what every key the locale's catalog lacks falls back to. */
  fallback: { locale: string; catalog: C }
  /** Other locales' catalogs, each partial. */
  catalogs?: Readonly<Record<string, Partial<Readonly<Record<keyof C, CopyEntry>>>>>
}

type Params = Readonly<Record<string, string | number>>

const SLOT = /\{([A-Za-z_$][\w$]*)\}/g

/** Fills each `{slot}` in one pass, with the value as plain text: a value is never read again as a template. */
function fill(text: string, params: Params | undefined): string {
  if (params === undefined) return text
  return text.replace(SLOT, (whole, slot: string) =>
    Object.hasOwn(params, slot) ? String(params[slot]) : whole
  )
}

function formOf(forms: PluralForms, count: unknown, rules: Intl.PluralRules): string {
  if (typeof count !== 'number') return forms.other
  if (count === 0 && forms['=0'] !== undefined) return forms['=0']
  return forms[rules.select(count)] ?? forms.other
}

export function createCopy<C extends CopyCatalog>(options: CopyOptions<C>): Copy<C> {
  const { locale, fallback } = options
  const own: Partial<Readonly<Record<string, CopyEntry>>> = options.catalogs?.[locale] ?? {}
  const ownRules = new Intl.PluralRules(locale)
  const fallbackRules = new Intl.PluralRules(fallback.locale)
  const listFormat = new Intl.ListFormat(locale, { type: 'unit', style: 'short' })

  function lookup(key: string, params?: Params): string {
    const ownEntry = own[key]
    const entry = ownEntry ?? fallback.catalog[key]
    // Unreachable through the types; the key itself is shown rather than nothing.
    if (entry === undefined) return key
    if (typeof entry === 'string') return fill(entry, params)
    const rules = ownEntry === undefined ? fallbackRules : ownRules
    return fill(formOf(entry, params?.count, rules), params)
  }

  return {
    locale,
    t: lookup as Translate<C>,
    list: (items) => listFormat.format(items)
  }
}

/**
 * The first of the person's preferred locales (BCP 47 tags, most preferred first) the app has a catalog for, matched
 * by the exact tag or by its language (`es-AR` → `es`), case-insensitively; `fallback` when none matches.
 */
export function resolveLocale<L extends string>(
  preferred: readonly string[],
  supported: readonly L[],
  fallback: L
): L {
  const find = (tag: string): L | undefined =>
    supported.find((locale) => locale.toLowerCase() === tag)
  for (const tag of preferred) {
    const wanted = tag.trim().toLowerCase()
    if (wanted === '') continue
    const match = find(wanted) ?? find(wanted.split(/[-_]/)[0] ?? '')
    if (match !== undefined) return match
  }
  return fallback
}
