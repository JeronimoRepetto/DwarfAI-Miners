import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The redesign's base rules, ported (#635): what every part gets before its own stylesheet says
 * anything. `foundations.md` ("Global rules") lists the design's base.css selector by selector;
 * `base.css` here is the product's copy, and these tests hold it to that list, declaration by
 * declaration, the way `designTokens.test.ts` holds the tokens to theirs.
 *
 * Read off disk for the same reason that file gives: a stylesheet rule has no module identity,
 * so the text is the only place to see it.
 */

const BASE = join(import.meta.dirname, 'base.css')
const GOLDEN = join(import.meta.dirname, '..', 'golden')

/**
 * Every rule in base.css, keyed by its selector list with the whitespace collapsed, each holding
 * its declarations in order. A deliberately small parser for a flat, hand-written file: no
 * nesting, no at-rules, comments stripped first.
 */
function rulesIn(file: string): Map<string, string[]> {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = new Map<string, string[]>()
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.replace(/\s+/g, ' ').trim()
    const declarations = match[2]!
      .split(';')
      .map((d) => d.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    rules.set(selector, [...(rules.get(selector) ?? []), ...declarations])
  }
  return rules
}

// The design's table, with each token written as the var() the product reads it through.
const DESIGN_BASE: [selector: string, declarations: string[]][] = [
  ['*, *::before, *::after', ['box-sizing: border-box']],
  ['html, body', ['margin: 0', 'height: 100%']],
  [
    'body',
    [
      'color: var(--ink)',
      'font: 400 var(--fs-meta) / 1.3 var(--f-meta)',
      '-webkit-font-smoothing: none',
      'text-rendering: optimizeSpeed'
    ]
  ],
  ['button, input, select, textarea', ['font: inherit', 'color: inherit']],
  ['button', ['cursor: pointer', 'background: none', 'border: 0', 'padding: 0', 'margin: 0']],
  ['button:disabled', ['cursor: not-allowed']],
  ['img', ['display: block']],
  ['p', ['margin: 0']],
  ['h1, h2, h3, h4', ['margin: 0', 'font-weight: 400']],
  ['ul, ol', ['margin: 0', 'padding: 0', 'list-style: none']],
  ['[hidden]', ['display: none !important']],
  [':focus', ['outline: none']],
  [
    ':focus-visible, .is-focus',
    ['outline: var(--px) solid var(--parchment)', 'outline-offset: 4px']
  ],
  ['*', ['scrollbar-width: thin', 'scrollbar-color: var(--brass-lo) var(--wood-lo)']],
  [
    '::-webkit-scrollbar',
    ['width: var(--size-scrollbar-width)', 'height: var(--size-scrollbar-width)']
  ],
  ['::-webkit-scrollbar-track', ['background: var(--wood-lo)']],
  [
    '::-webkit-scrollbar-thumb',
    [
      'background: var(--brass-lo)',
      'box-shadow: inset 2px 2px 0 0 var(--gold), inset -2px -2px 0 0 var(--gold-deep)'
    ]
  ],
  [
    '.sr-only',
    [
      'position: absolute',
      'width: 2px',
      'height: 2px',
      'padding: 0',
      'margin: -2px',
      'overflow: hidden',
      'clip: rect(0 0 0 0)',
      'white-space: nowrap',
      'border: 0'
    ]
  ],
  ['.pixelated', ['image-rendering: pixelated']]
]

describe('the redesign base rules in base.css', () => {
  const rules = rulesIn(BASE)

  it.each(DESIGN_BASE)('carries every declaration the design gives %s', (selector, expected) => {
    expect(rules.get(selector) ?? []).toEqual(expect.arrayContaining(expected))
  })

  it('draws no rounded scrollbar thumb, and no radius anywhere', () => {
    for (const declarations of rules.values()) {
      expect(declarations.filter((d) => d.startsWith('border-radius'))).toEqual([])
    }
  })

  /*
   * The one place the product departs from the design's base.css, on purpose: the rock is the
   * prototype's drawn desk, which foundations.md and handoff.md mark prototype only, and the
   * product's page is a frameless transparent window on the real desktop. Painting it would violate the rule the shell's fold exists to keep — the
   * window only ever adds or removes pixels that are already transparent (#388, useShellFold) —
   * and would frame the message panel's own window in rock (#162).
   */
  it('keeps the window itself transparent rather than painting the rock behind it', () => {
    expect(rules.get('html, body')).toEqual(expect.arrayContaining(['background: transparent']))
    for (const selector of ['html', 'body']) {
      const painted = (rules.get(selector) ?? []).filter((d) => d.startsWith('background'))
      expect(painted).toEqual([])
    }
  })
})

describe('the golden specimens after the base port', () => {
  // The specimen base shim stood in for these rules until the atoms slice ported them; the
  // goldens now grade the product's own base.css.
  it('carries no base shim of its own', () => {
    expect(existsSync(join(GOLDEN, 'specimenBaseShim.css'))).toBe(false)
    expect(readFileSync(join(GOLDEN, 'specimens.ts'), 'utf8')).not.toContain('golden-specimen')
  })
})
