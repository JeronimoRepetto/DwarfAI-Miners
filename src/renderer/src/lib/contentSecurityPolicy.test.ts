import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { policyAdmits, policySourcesFor } from './contentSecurityPolicy'

describe('policySourcesFor', () => {
  it('reads the source list a directive declares for itself', () => {
    expect(policySourcesFor("default-src 'self'; img-src 'self' data:", 'img-src')).toEqual([
      "'self'",
      'data:'
    ])
  })

  it('falls back to default-src for a directive the policy never names', () => {
    // The rule that made the shipped icons invisible: img-src was not declared,
    // so the browser used default-src, and `data:` is not `'self'`.
    expect(policySourcesFor("default-src 'self'", 'img-src')).toEqual(["'self'"])
  })

  it('governs nothing when neither the directive nor default-src is declared', () => {
    expect(policySourcesFor("script-src 'self'", 'font-src')).toEqual([])
  })

  it('is unbothered by the whitespace and trailing semicolons a policy may carry', () => {
    expect(policySourcesFor("  default-src 'self' ;  img-src   data: ;  ", 'img-src')).toEqual([
      'data:'
    ])
  })
})

describe('policyAdmits', () => {
  it('admits a source the governing list names', () => {
    expect(policyAdmits("img-src 'self' data:", 'img-src', 'data:')).toBe(true)
  })

  it('refuses a scheme the governing list leaves out', () => {
    expect(policyAdmits("default-src 'self'", 'img-src', 'data:')).toBe(false)
  })

  it('treats a wildcard as admitting anything', () => {
    expect(policyAdmits('img-src *', 'img-src', 'data:')).toBe(true)
  })

  it('admits anything when no directive governs at all', () => {
    expect(policyAdmits("script-src 'self'", 'font-src', 'data:')).toBe(true)
  })
})

/*
 * The regression itself (#156). Every icon in the SHIPPED app was invisible —
 * the navigation stack, the browse header, the mine's round close, the dwarf
 * status glyphs — and so were the app mark and the pixel font. The masks were
 * right and the data URIs were well formed; the document simply refused to load
 * them, because Vite inlines every small asset as a `data:` URI and the policy
 * admitted only `'self'`.
 *
 * It could not be seen in `pnpm dev`, where the same assets are served from the
 * dev server's own origin. That is what makes it worth pinning here rather than
 * leaving to an eye on a screenshot: the failure only ever reaches the user.
 */
describe('the shipped renderer document', () => {
  const html = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')
  const policy = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/.exec(html)?.[1]

  it('declares a policy at all, which is the whole reason the rest of this holds', () => {
    expect(policy).toBeDefined()
  })

  it('admits the inlined images the bundler actually emits', () => {
    expect(policyAdmits(policy ?? '', 'img-src', 'data:')).toBe(true)
  })

  it('admits the inlined pixel font the bundler actually emits', () => {
    expect(policyAdmits(policy ?? '', 'font-src', 'data:')).toBe(true)
  })

  it('keeps script execution to the bundle itself, which is what the policy is for', () => {
    // The relaxation above is per-directive on purpose. A `data:` image cannot
    // execute anything; a `data:` script can, so this one stays shut.
    expect(policyAdmits(policy ?? '', 'script-src', 'data:')).toBe(false)
    expect(policyAdmits(policy ?? '', 'script-src', "'unsafe-inline'")).toBe(false)
  })

  it('keeps the default closed, so a directive nobody thought about stays shut', () => {
    expect(policySourcesFor(policy ?? '', 'default-src')).toEqual(["'self'"])
  })
})
