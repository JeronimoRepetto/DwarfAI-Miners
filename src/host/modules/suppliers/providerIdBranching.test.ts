import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOG_PROVIDER_IDS } from '../../../contracts/catalog'

/**
 * R12 (05 §5.1; ADR-004 P9; ADR-009 Verification): behaviour branches on capabilities, never on a
 * provider id, so suppliers' domain and application code compare no provider-id literal. Read as
 * text with comments removed, so prose that names a provider is not a comparison. ESLint's R12
 * selectors cover the same ground for every module; this test pins the suppliers core, the place
 * where a branch on a catalog entry would be most tempting (17 §1.7, HO-14).
 */
const SUPPLIERS = import.meta.dirname
const CORE = ['domain', 'application'].map((layer) => join(SUPPLIERS, layer))

function productionFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|mts)$/.test(entry.name))
    .filter((entry) => !/\.test\.ts$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
}

/** `=== 'id'`, `'id' !==`, `case 'id'` for any catalog id, in any quote style. */
function providerComparison(ids: readonly string[]): RegExp {
  const literal = `(['"\`])(?:${ids.map(escape).join('|')})\\1`
  return new RegExp(`[!=]==\\s*${literal}|${literal}\\s*[!=]==|\\bcase\\s+${literal}`)
}

describe('provider-id branching (R12)', () => {
  it('[R12] no provider-id literal comparison exists in suppliers domain or application code', () => {
    const files = CORE.flatMap(productionFiles)
    expect(files.length).toBeGreaterThan(0)
    const comparison = providerComparison(CATALOG_PROVIDER_IDS)
    const violations = files
      .filter((file) => comparison.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(SUPPLIERS, file))
    expect(violations).toEqual([])
  })
})
