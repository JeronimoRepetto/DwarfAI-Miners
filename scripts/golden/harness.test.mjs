import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { judge, outputDir } from './compare.mjs'
import { rendererMismatch } from './renderer.mjs'
import { FRAMING_SELECTORS, stageCss } from './stage.mjs'

/*
 * The pure parts of the golden harness (#634), in the ordinary suite on every OS: the stage CSS
 * built from the design's own stylesheets, the renderer check (PO ruling G-01) and the verdict.
 * No browser, no design repository: the stylesheets here are small stand-ins written for the test,
 * not copies of the design's.
 */

const KIT = `/* chrome */
.kit-main { padding: 16px 20px 64px; }
.kit-stage {
  padding: 18px;
  background: var(--rock);
  box-shadow: inset 2px 2px 0 0 var(--rock-lo), inset -2px -2px 0 0 var(--rock-hi);
}
.kit-scene { position: relative; }
.kit-row { display: flex; }
.kit-plate { width: 96px; }
.kit-swatches { gap: 8px; }
.kit-swatch { gap: 3px; }
.kit-swatch__chip { box-shadow: 0 0 0 2px var(--rock-lo); }
.kit-tokens { gap: 4px; }
.kit-token { gap: 10px; }
@media (max-width: 700px) { .kit-cell--wide { grid-column: auto; } }
`
const TOKENS = `:root {
  color-scheme: dark;
  --rock: #14100b; /* the ground */
  --rock-hi: #221b13;
  --rock-lo: var(--shade);
  --shade: #0a0805;
}`

describe('stageCss', () => {
  it('keeps exactly the stage rule and the framing classes the reference docs list', () => {
    expect(FRAMING_SELECTORS).toEqual([
      '.kit-stage',
      '.kit-scene',
      '.kit-row',
      '.kit-plate',
      '.kit-swatches',
      '.kit-swatch',
      '.kit-swatch__chip',
      '.kit-tokens',
      '.kit-token'
    ])
    const css = stageCss(KIT, TOKENS)
    expect(css).not.toContain('.kit-main')
    expect(css).not.toContain('.kit-cell--wide')
    for (const selector of FRAMING_SELECTORS) expect(css).toContain(selector + ' {')
  })

  it('writes token values in place, so no design custom property reaches the component', () => {
    const css = stageCss(KIT, TOKENS)
    expect(css).not.toContain('var(')
    expect(css).toContain('background: #14100b')
    expect(css).toContain('inset 2px 2px 0 0 #0a0805, inset -2px -2px 0 0 #221b13')
  })

  it('fails when a framing rule is missing from the stylesheet', () => {
    expect(() => stageCss(KIT.replace('.kit-plate { width: 96px; }', ''), TOKENS)).toThrow(
      /\.kit-plate/
    )
  })

  it('fails when a token the rules use is not defined', () => {
    expect(() => stageCss(KIT, TOKENS.replace('--rock-hi: #221b13;', ''))).toThrow(/--rock-hi/)
  })
})

describe('rendererMismatch', () => {
  const recorded = {
    product: 'Edg/153.0.4234.48',
    userAgent: 'Mozilla/5.0 HeadlessChrome/153.0.0.0 Edg/153.0.0.0'
  }

  it('accepts the renderer the references were taken with', () => {
    expect(rendererMismatch({ ...recorded }, recorded)).toBeNull()
  })

  it('names both versions and the pin when the browser has updated itself', () => {
    const message = rendererMismatch(
      { product: 'Edg/154.0.1.2', userAgent: recorded.userAgent },
      recorded
    )
    expect(message).toContain('Edg/154.0.1.2')
    expect(message).toContain('Edg/153.0.4234.48')
    expect(message).toContain('GOLDEN_BROWSER')
  })

  it('fails on a different user agent with the same product', () => {
    const message = rendererMismatch({ product: recorded.product, userAgent: 'other' }, recorded)
    expect(message).toContain('other')
    expect(message).toContain(recorded.userAgent)
  })
})

describe('judge', () => {
  const same = { refWidth: 10, refHeight: 10, candWidth: 10, candHeight: 10, total: 100 }

  it('passes an identical capture at 0%', () => {
    expect(judge({ ...same, differing: 0, uncovered: 0, clusters: 0 })).toEqual({
      pass: true,
      percent: 0,
      reasons: []
    })
  })

  it('applies the acceptance rule: under 1% and no cluster', () => {
    expect(judge({ ...same, total: 1000, differing: 9, uncovered: 0, clusters: 0 }).pass).toBe(true)
    expect(judge({ ...same, total: 1000, differing: 10, uncovered: 0, clusters: 0 }).pass).toBe(
      false
    )
    expect(judge({ ...same, differing: 0, uncovered: 0, clusters: 1 }).reasons).toEqual([
      '1 cluster of 3x3 or more'
    ])
  })

  it('fails a size mismatch first', () => {
    const v = judge({
      ...same,
      candWidth: 11,
      total: 110,
      differing: 0,
      uncovered: 10,
      clusters: 0
    })
    expect(v.pass).toBe(false)
    expect(v.reasons[0]).toBe('the sizes differ (11x10 against 10x10)')
  })
})

describe('outputDir', () => {
  it('lives under the system temp directory, never in the checkout', () => {
    const tmp = path.resolve('/tmp-root')
    expect(outputDir(tmp)).toBe(path.join(tmp, 'dwarfai-golden'))
  })
})
