import { describe, expect, it } from 'vitest'
import { CATALOG_PROVIDER_IDS } from './ids'
import { providerLiteralPattern } from './providerLiteral.mjs'

/** The R12 pattern is a `/…/` regex source for an esquery selector; this turns it into a RegExp. */
function toRegExp(pattern: string): RegExp {
  expect(pattern.startsWith('/') && pattern.endsWith('/')).toBe(true)
  return new RegExp(pattern.slice(1, -1))
}

describe('catalog provider ids (05 §5.3, R12)', () => {
  it('[R12] CATALOG_PROVIDER_IDS is a frozen, non-empty list of unique lower-case ids', () => {
    expect(Object.isFrozen(CATALOG_PROVIDER_IDS)).toBe(true)
    expect(CATALOG_PROVIDER_IDS.length).toBeGreaterThan(0)
    expect(new Set(CATALOG_PROVIDER_IDS).size).toBe(CATALOG_PROVIDER_IDS.length)
    for (const id of CATALOG_PROVIDER_IDS) {
      expect(id.length).toBeGreaterThan(0)
      expect(id).toBe(id.toLowerCase())
    }
  })

  it('[R12] providerLiteralPattern covers every catalog id and a synthetic id added to the list', () => {
    const synthetic = 'synthetic-provider'
    const ids = [...CATALOG_PROVIDER_IDS, synthetic]
    const pattern = toRegExp(providerLiteralPattern(ids))

    for (const id of ids) expect(pattern.test(id)).toBe(true)
    // Nothing else: not a prefix, a suffix, a concatenation or an unknown id.
    for (const other of [
      '',
      'synthetic',
      'provider',
      `${synthetic}x`,
      `x${synthetic}`,
      'unknown'
    ]) {
      expect(pattern.test(other)).toBe(false)
    }
    for (const id of CATALOG_PROVIDER_IDS) {
      expect(pattern.test(`${id}${synthetic}`)).toBe(false)
      expect(pattern.test(`${id}|${synthetic}`)).toBe(false)
    }
  })

  it("[R12] providerLiteralPattern escapes '-' so an id with a dash matches only itself", () => {
    const source = providerLiteralPattern(['alpha', 'open-code'])
    expect(source).toBe('/^(alpha|open\\-code)$/')

    const pattern = toRegExp(source)
    expect(pattern.test('open-code')).toBe(true)
    for (const other of ['open', 'code', 'opencode', 'open-codex', 'xopen-code', 'open_code']) {
      expect(pattern.test(other)).toBe(false)
    }
  })
})
