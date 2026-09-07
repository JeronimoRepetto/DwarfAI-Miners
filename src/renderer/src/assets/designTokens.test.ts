import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The design source's named values have exactly ONE home (#90).
 *
 * Two token files coexisted while the rebuild was partial, and four of the
 * design's colours ended up declared in both — a corrected hex would then have
 * silently applied in one screen and not the other, with cascade order deciding
 * which. These tests are the enforcement: `design-tokens.css` carries the design
 * source's palette and metrics, `theme.css` carries what is left of the ORIGINAL
 * interface's palette, and no custom property may be declared in two files.
 *
 * Read off disk rather than through a bundler on purpose: a CSS custom property
 * has no module identity, so the only place the duplication is visible is the
 * text of the files themselves.
 */

const ASSETS_DIR = join(import.meta.dirname)

interface Declaration {
  file: string
  /** The selector block the declaration sits in, e.g. `:root` or `[data-tier='gold']`. */
  selector: string
  name: string
}

/**
 * Every `--name:` declaration in one stylesheet, with the selector it belongs
 * to. A deliberately small parser: these files are hand-written, flat, and have
 * no nesting or at-rule-scoped custom properties, and a real CSS parser would be
 * a dependency bought to read four files.
 */
function declarationsIn(file: string): Declaration[] {
  const css = readFileSync(join(ASSETS_DIR, file), 'utf8')
  const found: Declaration[] = []
  let selector = ''
  for (const raw of css.split('\n')) {
    const line = raw.trim()
    if (line.endsWith('{')) {
      selector = line.slice(0, -1).trim()
      continue
    }
    const declaration = /^(--[a-z0-9-]+)\s*:/i.exec(line)
    if (declaration !== null) found.push({ file, selector, name: declaration[1]! })
  }
  return found
}

function cssFiles(): string[] {
  return readdirSync(ASSETS_DIR)
    .filter((entry) => entry.endsWith('.css'))
    .sort()
}

describe('renderer stylesheet custom properties', () => {
  it('declares no custom property in more than one stylesheet', () => {
    const byName = new Map<string, Set<string>>()
    for (const file of cssFiles()) {
      for (const declaration of declarationsIn(file)) {
        const files = byName.get(declaration.name) ?? new Set<string>()
        files.add(declaration.file)
        byName.set(declaration.name, files)
      }
    }
    const shared = [...byName.entries()]
      .filter(([, files]) => files.size > 1)
      .map(([name, files]) => `${name} in ${[...files].sort().join(' + ')}`)
    expect(shared).toEqual([])
  })

  it('declares no custom property twice inside one selector block', () => {
    const duplicates: string[] = []
    for (const file of cssFiles()) {
      const seen = new Set<string>()
      for (const declaration of declarationsIn(file)) {
        const key = `${declaration.file} ${declaration.selector} ${declaration.name}`
        if (seen.has(key)) duplicates.push(key)
        seen.add(key)
      }
    }
    expect(duplicates).toEqual([])
  })
})

/**
 * The design source's foundations table, transcribed. Every value here is
 * quoted from `docs/dwarfai-miners-design/foundations.md`; the token names are
 * the ones that file suggests, so a reader can hold the two side by side.
 */
describe('design-tokens.css against the design foundations', () => {
  const css = readFileSync(join(ASSETS_DIR, 'design-tokens.css'), 'utf8')

  function valueOf(name: string): string | null {
    const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css)
    return match === null ? null : match[1]!.trim()
  }

  it.each([
    ['--color-rail', '#f6b644'],
    ['--color-cream', '#fae2b6'],
    ['--color-nav-idle', '#110c07'],
    ['--color-panel-deep', '#14100b'],
    ['--color-panel', '#2b2119'],
    ['--color-control', '#272015'],
    ['--color-accent', '#d19831'],
    ['--color-tooltip-text', '#f7dcaf'],
    ['--color-white', '#ffffff'],
    ['--color-black', '#000000'],
    ['--color-question-dark', '#13100a']
  ])('carries the design colour %s as %s', (name, value) => {
    expect(valueOf(name)).toBe(value)
  })

  /*
   * #198: the design source's 10/12/14/19/24px scale read too small on a real
   * desktop (the 10px meta size above all), and the maintainer's 2026-09-04
   * ruling raised every rung by 2px rather than one. `foundations.md`'s
   * Typography table carries the amendment note; this is its transcription.
   */
  it.each([
    ['--text-meta', '12px'],
    ['--text-helper', '14px'],
    ['--text-section', '16px'],
    ['--text-title', '21px'],
    ['--text-headline', '26px']
  ])('carries the design type size %s as %s', (name, value) => {
    expect(valueOf(name)).toBe(value)
  })

  it.each([
    ['--space-nav-gap', '8px'],
    ['--space-settings', '10px'],
    ['--space-modal-margin', '12px'],
    ['--space-map-pad', '21px']
  ])('carries the design spacing %s as %s', (name, value) => {
    expect(valueOf(name)).toBe(value)
  })

  it.each([
    ['--size-rail-width', '20px'],
    ['--size-icon', '19px'],
    ['--size-marker-width', '10px'],
    ['--size-sleep-icon', '15px'],
    ['--size-search-height', '30px'],
    ['--size-chip-height', '25px'],
    ['--size-shortcut-height', '42px'],
    ['--size-card-height', '120px'],
    ['--size-card-art-width', '120px'],
    ['--size-card-art-height', '90px'],
    ['--size-portrait', '100px'],
    ['--size-tooltip-width', '170px'],
    ['--size-tooltip-height', '60px'],
    ['--size-mine-interior-width', '245px'],
    ['--size-feature-panel-width', '487px'],
    ['--size-message-panel-width', '990px'],
    ['--size-message-input-width', '865px']
  ])('carries the design size %s as %s', (name, value) => {
    expect(valueOf(name)).toBe(value)
  })

  /*
   * The Mine History panel's own ceiling (#192, `screens/history.md`: "500px
   * maximum height"). Not in the foundations table — it arrived with the v3
   * history screen — but a design value all the same, so it has the same one
   * home as the rest.
   */
  it('carries the history panel maximum height as 500px', () => {
    expect(valueOf('--size-history-panel-max-height')).toBe('500px')
  })

  /*
   * #195: the design source gives no scrollbar recipe, so this width is ours
   * (see the token's own comment) rather than a transcription — what is
   * pinned is that ONE value exists here for every scrollable surface, the
   * same discipline `--elevation-5` already holds for its own undocumented
   * recipe.
   */
  it('carries the scrollbar width the design leaves without a recipe', () => {
    expect(valueOf('--size-scrollbar-width')).toBe('8px')
  })

  it('keeps one radius for rails, panels, cards, inputs, buttons and dialogs', () => {
    expect(valueOf('--radius-default')).toBe('12px')
  })

  it.each([
    ['--border-highlight', '2px solid var(--color-cream)'],
    ['--border-heavy', '4px solid var(--color-cream)'],
    ['--border-active', '2px solid var(--color-accent)']
  ])('carries the design border %s as %s', (name, value) => {
    expect(valueOf(name)).toBe(value)
  })

  /**
   * The design names elevation `5` and does not give a shadow formula, so the
   * recipe is ours (see the comment at the token). What is pinned here is only
   * that ONE recipe exists under the design's own name: components must not each
   * invent a shadow for the same named elevation.
   */
  it('names the elevation the design leaves without a recipe', () => {
    expect(valueOf('--elevation-5')).toBeTruthy()
  })

  /**
   * The five marker colours the design source names only by family — "Bronze
   * (cyan), Copper (orange-brown), Silver (gray), Gold (yellow), Uranium
   * (green)" — Copper per the maintainer's #165 reversal, not the earlier
   * "Cropper" this quote used to read — with `foundations.md` stating
   * outright that the PDF gives no hex values and pointing at the verified
   * Canva export instead.
   *
   * So unlike every value above, these are not transcribed from a table: they
   * were MEASURED off `assets/map/map-mine-markers.png` by
   * `scripts/extract-map-markers.mjs`, which finds the five flat-fill discs on
   * the map and reports each one's exact RGB. What is pinned here is that
   * measurement — a re-run of that script against a revised export is what may
   * change these numbers, never a judgement about which cyan looks right.
   */
  it.each([
    ['--color-marker-bronze', '#5ce1e6'],
    ['--color-marker-copper', '#ba6336'],
    ['--color-marker-silver', '#c7c7c7'],
    ['--color-marker-gold', '#ffde59'],
    ['--color-marker-uranium', '#00bf63']
  ])('carries the sampled marker colour %s as %s', (name, value) => {
    expect(valueOf(name)).toBe(value)
  })

  it('names the pixel family the design calls Pixel UI, with a fallback stack', () => {
    const family = valueOf('--font-pixel')
    expect(family).toContain('Tiny5')
    // "fallback stack is Unspecified" in the source, but shipping a single
    // family means a font that failed to load renders in whatever the platform
    // picked — which for a 10px UI is not a survivable outcome.
    expect(family!.split(',').length).toBeGreaterThan(1)
  })
})

/*
 * #198: raising the scale in this one file is only real if nothing in a
 * component still spells its own pixel size — a hardcoded `font-size: 10px`
 * compiles and renders exactly like `font-size: var(--text-meta)`, so no
 * other check would ever catch a fresh literal landing beside a token. Walked
 * off disk rather than through a bundler, the same reasoning as the custom
 * property tests above: a `.vue` file's `<style>` block has no import a test
 * could assert against.
 */
describe('renderer components against the type scale tokens', () => {
  const RENDERER_SRC = join(ASSETS_DIR, '..')

  function vueFiles(dir: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) found.push(...vueFiles(full))
      else if (entry.isFile() && entry.name.endsWith('.vue')) found.push(full)
    }
    return found
  }

  it('never sets font-size to a hardcoded pixel literal', () => {
    const offenders: string[] = []
    for (const file of vueFiles(RENDERER_SRC)) {
      const matches = readFileSync(file, 'utf8').match(/font-size\s*:\s*\d+(\.\d+)?px/g)
      if (matches !== null) offenders.push(`${file}: ${matches.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })
})
