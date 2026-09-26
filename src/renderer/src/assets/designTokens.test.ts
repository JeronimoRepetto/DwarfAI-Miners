import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
/* --- Typography preferences (#370) — one block, appended ------------------- */
import { DEFAULT_TYPOGRAPHY_PREFERENCES, INTERFACE_FONTS } from '../types'
/* --- end of the #370 block ------------------------------------------------- */

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

  /*
   * AMENDED for #370: the same reading, one indirection later.
   *
   * The two font tokens are no longer literal stacks — they name one of the
   * four `--font-family-*` tokens the Typography preference switches between,
   * because a face has to be selectable at runtime and a stack spelled twice
   * would be two answers. Every assertion below is unchanged; they read the
   * stack the token resolves to rather than the token's own text.
   */
  function resolvedValueOf(name: string): string | null {
    let value = valueOf(name)
    for (let hop = 0; hop < 4 && value !== null; hop += 1) {
      const reference = /^var\((--[a-z0-9-]+)\)$/i.exec(value)
      if (reference === null) return value
      value = valueOf(reference[1]!)
    }
    return value
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
    // AMENDED for #635: the value is unchanged, read one indirection later —
    // the old app names now alias the redesign's tokens (handoff, Token mapping).
    expect(resolvedValueOf(name)).toBe(value)
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
    // AMENDED for #635: unchanged value, now held by `--tier-*` and aliased here.
    expect(resolvedValueOf(name)).toBe(value)
  })

  it('names the pixel family the design calls Pixel UI, with a fallback stack', () => {
    const family = resolvedValueOf('--font-pixel')
    expect(family).toContain('Tiny5')
    // "fallback stack is Unspecified" in the source, but shipping a single
    // family means a font that failed to load renders in whatever the platform
    // picked — which for a 10px UI is not a survivable outcome.
    expect(family!.split(',').length).toBeGreaterThan(1)
  })

  /*
   * The SECOND face (#347, maintainer amendment 2026-09-09). Tiny5 has one
   * weight and is a display face; what a dwarf or the person says is now
   * paragraphs with real bold, lists and code, and a single-weight pixel face
   * can draw none of that. Same fallback shape as --font-pixel above, and for
   * the same reason.
   */
  it('names the conversation family the design added for what the crew says', () => {
    const family = resolvedValueOf('--font-conversation')
    expect(family).toContain('Pixelify Sans')
    expect(family!.split(',').length).toBeGreaterThan(1)
  })

  it('carries the conversation body size the amendment fixes at 14px', () => {
    expect(valueOf('--text-conversation')).toBe('14px')
  })

  /*
   * APPENDED for #370 (maintainer amendment 2026-09-10). Settings offers four
   * interface faces and three messaging ones, and the composable that applies a
   * choice does it by pointing --font-pixel or --font-conversation at one of
   * these tokens. So every face the wire admits needs a stack declared HERE:
   * a missing one resolves to nothing, and `font-family:` with nothing in it is
   * a declaration the browser drops — the element would silently keep whatever
   * it inherited, which is the failure mode hardest to see.
   */
  it.each([...INTERFACE_FONTS])('declares a stack for the %s face Settings offers', (font) => {
    const family = valueOf(`--font-family-${font}`)
    expect(family).toBeTruthy()
    // The same fallback rule --font-pixel has held since #90: a face that
    // failed to load must still leave a 12px label readable.
    expect(family!.split(',').length).toBeGreaterThan(1)
  })

  it('leaves the two roles pointing at the faces the defaults name', () => {
    // The stylesheet is what paints before main answers, so its own values are
    // DEFAULT_TYPOGRAPHY_PREFERENCES spelled in CSS. A drift here would show
    // the wrong face for one frame on every launch.
    expect(valueOf('--font-pixel')).toBe(
      `var(--font-family-${DEFAULT_TYPOGRAPHY_PREFERENCES.interfaceFont})`
    )
    expect(valueOf('--font-conversation')).toBe(
      `var(--font-family-${DEFAULT_TYPOGRAPHY_PREFERENCES.messagingFont})`
    )
  })

  it('spells Arial as the platform face with a sans-serif fallback, not as a bundled one', () => {
    // The one face the app does not ship: the design's amendment says to use
    // the platform's own, so the stack must not quote a family this repo would
    // then be expected to carry.
    const family = valueOf('--font-family-arial')!
    expect(family).toContain('Arial')
    expect(family).toContain('sans-serif')
  })

  /*
   * APPENDED for #548 (maintainer ruling 2026-09-21). `foundations.md` gives
   * `--color-control` three roles at once — "Enabled button/control background
   * and unselected chip border/text" — and the third is unusable: `#272015`
   * text on the `#14100b` it sits on measures 1.18:1, where 1.00:1 is the same
   * colour. The unselected half of every segmented control was therefore
   * invisible, which is why a routing profile that really had changed looked
   * like a control that never responded.
   *
   * This is not a palette taste correction. `foundations.md`'s own gap table
   * marks accessibility — "no focus, keyboard traversal, contrast rationale" —
   * as "Requires design/product definition", so the contrast floor was never
   * specified and asking was the documented route (`ui-rebuild`). The ruling
   * fills that gap, the way #198's did for the type scale.
   *
   * `--color-control` KEEPS its value: 18 surfaces are painted with it and it
   * is correct as a background. What is new is a FOREGROUND token for the
   * idle role, named after `--color-nav-idle`, which already holds exactly
   * this "unselected, still legible" job for the shell rail.
   */
  function contrastRatio(foreground: string, background: string): number {
    const luminance = (hex: string): number => {
      const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
    }
    const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
    return (lighter! + 0.05) / (darker! + 0.05)
  }

  it('measures the contrast of a known pair the way WCAG does', () => {
    // The helper above is the whole enforcement below, so it is pinned against
    // a pair computed by hand first: black on white is WCAG's own 21:1.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    // And the defect this issue exists for, so the number is on the record.
    expect(contrastRatio('#272015', '#14100b')).toBeLessThan(1.2)
  })

  it.each([['--color-panel-deep'], ['--color-panel']])(
    'keeps the idle control foreground readable on %s',
    (background) => {
      const idle = valueOf('--color-control-idle')
      expect(idle).toBeTruthy()
      // WCAG AA for normal text. An unselected option is one the person is
      // about to choose, so it has to be READ, not merely sensed — this is the
      // floor the ruling set, and the reason a fresh token exists at all.
      expect(contrastRatio(idle!, resolvedValueOf(background)!)).toBeGreaterThanOrEqual(4.5)
    }
  )

  /*
   * The role splits in two, which is why there are two tokens and not one.
   *
   * An UNSELECTED option is one the person is about to choose: it has to be
   * read, so it takes the AA floor above. A DISABLED control cannot be chosen
   * at all, and WCAG exempts it — but 1.18:1 does not render it "switched
   * off", it renders it GONE, and a confirm button whose word has vanished
   * reads as broken rather than as unavailable. So disabled is dimmer than
   * idle and still present, which is the distinction the old single token
   * could not express.
   */
  it('keeps a disabled control legible enough to still read as a control', () => {
    const disabled = valueOf('--color-control-disabled')
    expect(disabled).toBeTruthy()
    // The 3:1 WCAG gives non-text UI, applied here to a word nobody may click:
    // enough to see WHAT is unavailable, never enough to look available.
    expect(contrastRatio(disabled!, resolvedValueOf('--color-panel-deep')!)).toBeGreaterThanOrEqual(
      3
    )
  })

  it('keeps disabled visibly quieter than merely unselected', () => {
    const ground = resolvedValueOf('--color-panel-deep')!
    const disabled = contrastRatio(valueOf('--color-control-disabled')!, ground)
    const idle = contrastRatio(valueOf('--color-control-idle')!, ground)
    // The whole point of two tokens: cannot-be-chosen must not look the same
    // as could-be-chosen-but-is-not.
    expect(disabled).toBeLessThan(idle)
  })

  it('keeps the idle foreground quieter than the selected one, so the states still differ', () => {
    const idle = contrastRatio(
      valueOf('--color-control-idle')!,
      resolvedValueOf('--color-panel-deep')!
    )
    const selected = contrastRatio(
      resolvedValueOf('--color-cream')!,
      resolvedValueOf('--color-panel-deep')!
    )
    // Legible is not the same as loud: if idle ever reached the selected
    // state's own contrast, the control would read as having every option
    // chosen — the mirror of the bug being fixed.
    expect(idle).toBeLessThan(selected)
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

  /*
   * #548, and the same reasoning #198's check above is built on: raising the
   * idle role in the token file is only real if no component still paints a
   * foreground with the SURFACE token. `color: var(--color-control)` renders
   * at 1.18:1 on the ground these controls sit on and compiles exactly like
   * the legible one, so no other check would catch a fresh one landing.
   *
   * The background role is untouched and deliberately not matched here:
   * `--color-control` is the correct fill for 18 enabled surfaces.
   */
  /*
   * The same defect wearing a `background:` (#548). An icon here is a CSS
   * mask, so its own colour is painted as the fill BEHIND the mask — the
   * property says background, the pixels are foreground, and the check above
   * cannot tell the two apart. `.add-control:disabled .control-glyph` carried
   * a comment promising it "reads as switched off rather than as missing",
   * and at 1.18:1 it read as missing, which is the gap this measures shut.
   *
   * Keyed on the repo's own `-glyph` naming for a masked icon, because that
   * convention is the only thing in the text that distinguishes a mask fill
   * from a real surface.
   */
  it('never fills a masked icon with the control SURFACE colour', () => {
    const offenders: string[] = []
    for (const file of vueFiles(RENDERER_SRC)) {
      let selector = ''
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        const line = raw.trim()
        if (line.endsWith('{')) selector = line.slice(0, -1).trim()
        else if (
          /^background\s*:\s*var\(--color-control\)\s*;$/.test(line) &&
          /glyph/.test(selector)
        ) {
          offenders.push(`${file}: ${selector}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('never paints a foreground with the control SURFACE colour', () => {
    const offenders: string[] = []
    for (const file of vueFiles(RENDERER_SRC)) {
      const matches = readFileSync(file, 'utf8').match(
        /(?:^|\n)\s*color\s*:\s*var\(--color-control\)/g
      )
      if (matches !== null) offenders.push(`${file}: ${matches.length} occurrence(s)`)
    }
    expect(offenders).toEqual([])
  })

  /*
   * #347: the amendment is only real if the surfaces it names actually ask for
   * the second face. Walked off disk for the reason the size check above is —
   * a `<style>` block has no import a test could assert against — and named
   * one surface at a time, because "the crew's own words" is a judgement about
   * WHICH element, not a pattern a regex could find on its own.
   */
  it.each([
    ['components/message/DwarfMessagePanel.vue', '.bubble'],
    ['components/dwarf/DwarfQuestionCard.vue', '.question-text'],
    ['components/dwarf/DwarfPermissionCard.vue', '.permission-description'],
    // APPENDED for #370: the Add Panel joins the list. It is where the person
    // composes the first thing they SAY to a session, and the issue's own
    // wording is that it must resolve the same messaging family MessagePanel
    // does — it was the one conversation surface still on the Pixel UI face.
    ['components/launch/AddPanel.vue', '.add-panel']
  ])('sets %s, which carries %s, in the conversation family', (file) => {
    expect(readFileSync(join(RENDERER_SRC, file), 'utf8')).toContain('var(--font-conversation)')
  })

  /*
   * Both faces are BUNDLED, never fetched. index.html's policy admits no remote
   * origin (see lib/contentSecurityPolicy), so a token naming a family nobody
   * imported would silently render the fallback stack in a shipped build and
   * nowhere else — exactly the failure #156 was.
   */
  it('bundles both faces rather than trusting the machine to have them', () => {
    const entry = readFileSync(join(RENDERER_SRC, 'main.ts'), 'utf8')
    expect(entry).toContain('@fontsource/tiny5')
    expect(entry).toContain('@fontsource-variable/pixelify-sans')
    // APPENDED for #370: Roboto is the third bundled face, and the reason it is
    // a stylesheet in `assets/fonts/` rather than a package is that it is the
    // only one this repo carries the files for itself.
    expect(entry).toContain('./assets/fonts/roboto/roboto.css')
  })

  /*
   * APPENDED for #370. Arial is the one offered face nothing is bundled for —
   * the design's amendment says to use the platform's own — so the check that
   * every OTHER face is bundled has to know which one is exempt, and say so
   * here rather than leave a reader counting imports.
   */
  it('bundles every offered face except Arial, which is the platform’s own', () => {
    const entry = readFileSync(join(RENDERER_SRC, 'main.ts'), 'utf8')
    expect(entry).not.toContain('arial')
    expect(entry.toLowerCase()).toContain('roboto')
  })
})

/* --- The redesign's foundations (#635) — one block, appended --------------- */

/**
 * The redesign's tokens, under the names its foundations give them, so the golden specimens and
 * every rebuilt component read `var(--rock)` rather than a legacy alias.
 *
 * Read with a small rule parser of its own rather than the `valueOf` regex above: that one is
 * unanchored, so `--gold` would match inside `--tier-gold`, and it cannot tell a `:root` value
 * from the same name redeclared inside an at-rule.
 */
interface CssRule {
  /** The enclosing at-rules, e.g. `@media (prefers-reduced-motion: reduce)`, or ''. */
  atRule: string
  selector: string
  declarations: Map<string, string>
}

function rulesIn(file: string): CssRule[] {
  const css = readFileSync(join(ASSETS_DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: CssRule[] = []
  const atRules: string[] = []
  let current: CssRule | null = null
  let buffer = ''
  for (const char of css) {
    if (char === '{') {
      const head = buffer.trim().replace(/\s+/g, ' ')
      buffer = ''
      if (head.startsWith('@')) atRules.push(head)
      else {
        current = { atRule: atRules.join(' '), selector: head, declarations: new Map() }
        rules.push(current)
      }
    } else if (char === ';' || char === '}') {
      const text = buffer.trim()
      buffer = ''
      if (current !== null && text !== '') {
        const colon = text.indexOf(':')
        const value = text
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, ' ')
        current.declarations.set(text.slice(0, colon).trim(), value)
      }
      if (char === '}') {
        if (current !== null) current = null
        else atRules.pop()
      }
    } else {
      buffer += char
    }
  }
  return rules
}

function declared(file: string, selector: string, name: string, atRule = ''): string | undefined {
  const matches = rulesIn(file).filter(
    (rule) => rule.selector === selector && rule.atRule === atRule && rule.declarations.has(name)
  )
  return matches.at(-1)?.declarations.get(name)
}

const rootToken = (name: string): string | undefined => declared('design-tokens.css', ':root', name)

describe('design-tokens.css against the redesign foundations (#635)', () => {
  it.each([
    ['--rock-hi', '#221b13'],
    ['--rock', '#14100b'],
    ['--rock-lo', '#0a0805'],
    ['--wood-hi', '#3d2f23'],
    ['--wood', '#2b2119'],
    ['--wood-lo', '#1c150f'],
    ['--control-hi', '#3a2f20'],
    ['--control', '#272015'],
    ['--control-lo', '#17120b'],
    ['--gold-hi', '#e8b451'],
    ['--gold', '#d19831'],
    ['--gold-lo', '#9a6c1f'],
    ['--gold-select', '#865e1b'],
    ['--gold-deep', '#6e4c14'],
    ['--brass-hi', '#ffd27a'],
    ['--brass', '#f6b644'],
    ['--brass-lo', '#b9832a'],
    ['--parch-hi', '#fff1d6'],
    ['--parchment', '#fae2b6'],
    ['--parch-lo', '#d9bd8c'],
    ['--steel-hi', '#c9ced3'],
    ['--steel', '#9aa0a6'],
    ['--steel-lo', '#5d6369'],
    ['--ink', '#f3dcb2'],
    ['--ink-soft', '#c9b08a'],
    ['--ink-faint', '#ad9674'],
    ['--ink-on-light', '#2b2119'],
    ['--ink-on-light-soft', '#443629'],
    ['--ok', '#8fbf5a'],
    ['--ok-lo', '#2e3a1f'],
    ['--warn', '#e0a33a'],
    ['--warn-lo', '#3a2c14'],
    ['--danger', '#d0583c'],
    ['--danger-hi', '#e98a70'],
    ['--danger-lo', '#3a1c15'],
    ['--danger-badge', '#b74d35'],
    ['--info', '#6fb3c4'],
    ['--info-lo', '#1d3036'],
    ['--tier-bronze', '#5ce1e6'],
    ['--tier-bronze-lo', '#173d3f'],
    ['--tier-copper', '#ba6336'],
    ['--tier-copper-lo', '#45230f'],
    ['--tier-silver', '#c7c7c7'],
    ['--tier-silver-lo', '#3b3d40'],
    ['--tier-gold', '#ffde59'],
    ['--tier-gold-lo', '#4d3f0e'],
    ['--tier-uranium', '#00bf63'],
    ['--tier-uranium-lo', '#0a3520']
  ])('carries the redesign colour %s as %s', (name, value) => {
    expect(rootToken(name)).toBe(value)
  })

  it.each([
    ['--shadow-drop', 'rgba(0, 0, 0, 0.45)'],
    ['--scrim', 'rgba(10, 8, 5, 0.72)'],
    ['--veil', 'rgba(0, 0, 0, 0.5)'],
    ['--glow-brass', 'rgba(246, 182, 68, 0.35)'],
    ['--glow-parch', 'rgba(250, 226, 182, 0.18)'],
    ['--hover-wash', 'rgba(250, 226, 182, 0.06)']
  ])('carries the translucent layer %s as %s', (name, value) => {
    expect(rootToken(name)).toBe(value)
  })

  it('ports none of the tokens the design keeps for its own drawn desktop', () => {
    expect(rootToken('--desk')).toBeUndefined()
    expect(rootToken('--desk-glow')).toBeUndefined()
  })

  /*
   * The rename the handoff's token mapping calls for, one step at a time: the redesign's name
   * holds the value and the old app name reads it, so a palette correction is one edit while
   * callers still ask for the old name. Each caller moves in its own rebuild slice.
   */
  it.each([
    ['--color-panel-deep', 'var(--rock)'],
    ['--color-panel', 'var(--wood)'],
    ['--color-control', 'var(--control)'],
    ['--color-accent', 'var(--gold)'],
    ['--color-rail', 'var(--brass)'],
    ['--color-cream', 'var(--parchment)'],
    ['--color-marker-bronze', 'var(--tier-bronze)'],
    ['--color-marker-copper', 'var(--tier-copper)'],
    ['--color-marker-silver', 'var(--tier-silver)'],
    ['--color-marker-gold', 'var(--tier-gold)'],
    ['--color-marker-uranium', 'var(--tier-uranium)']
  ])('keeps the old app name %s as an alias of %s', (name, alias) => {
    expect(rootToken(name)).toBe(alias)
  })

  /*
   * The three collisions the handoff names: the redesign's values ship, and theme.css stops
   * declaring them — removed, never renamed to a `--legacy-*` copy that would keep two answers.
   */
  it.each(['--ink', '--ink-faint', '--parchment'])(
    'leaves %s to design-tokens.css alone, with no legacy copy in theme.css',
    (name) => {
      const themeNames = rulesIn('theme.css').flatMap((rule) => [...rule.declarations.keys()])
      expect(themeNames).not.toContain(name)
      expect(themeNames).not.toContain('--legacy-' + name.slice(2))
      expect(rootToken(name)).toBeTruthy()
    }
  )

  it('draws one art pixel of chrome as 2px, and names the empty extra ring', () => {
    expect(rootToken('--px')).toBe('2px')
    expect(rootToken('--ring-none')).toBe('0 0 0 0 transparent')
  })

  it('builds the notched frame from the five material variables', () => {
    const at = (name: string) => declared('design-tokens.css', '.m-mat', name)
    expect(at('--mat-fill')).toBe('var(--wood)')
    expect(at('--mat-hi')).toBe('var(--wood-hi)')
    expect(at('--mat-lo')).toBe('var(--wood-lo)')
    expect(at('--mat-edge')).toBe('var(--rock-lo)')
    expect(at('--mat-extra')).toBe('var(--ring-none)')
    expect(at('background-color')).toBe('var(--mat-fill)')
    expect(at('box-shadow')).toBe(
      [
        '0 calc(var(--px) * -1) 0 0 var(--mat-edge)',
        '0 var(--px) 0 0 var(--mat-edge)',
        'calc(var(--px) * -1) 0 0 0 var(--mat-edge)',
        'var(--px) 0 0 0 var(--mat-edge)',
        'inset var(--px) var(--px) 0 0 var(--mat-hi)',
        'inset calc(var(--px) * -1) calc(var(--px) * -1) 0 0 var(--mat-lo)',
        'var(--mat-extra)'
      ].join(', ')
    )
  })

  it('rounds no corner: stepped corners replace the radius on every material', () => {
    const materials = rulesIn('design-tokens.css').filter((rule) => rule.selector.startsWith('.m-'))
    expect(materials.length).toBeGreaterThan(0)
    for (const rule of materials) expect(rule.declarations.has('border-radius')).toBe(false)
  })

  it.each([
    ['.m-wood', { fill: 'wood', hi: 'wood-hi', lo: 'wood-lo' }],
    ['.m-control', { fill: 'control', hi: 'control-hi', lo: 'control-lo' }],
    ['.m-rock', { fill: 'rock', hi: 'rock-hi', lo: 'rock-lo' }],
    ['.m-well', { fill: 'rock', hi: 'rock-lo', lo: 'rock-hi', edge: 'wood-lo' }],
    [
      '.m-parchment',
      { fill: 'parchment', hi: 'parch-hi', lo: 'parch-lo', edge: 'rock-lo', color: 'ink-on-light' }
    ],
    [
      '.m-parchment-well',
      { fill: 'parch-hi', hi: 'parch-lo', lo: 'parch-hi', edge: 'wood-lo', color: 'ink-on-light' }
    ],
    [
      '.m-brass',
      { fill: 'brass', hi: 'brass-hi', lo: 'brass-lo', edge: 'rock-lo', color: 'ink-on-light' }
    ],
    ['.m-gold', { fill: 'gold-lo', hi: 'gold', lo: 'gold-deep', edge: 'brass-hi' }]
  ])('paints the %s material from its variables', (selector, material) => {
    const at = (name: string) => declared('design-tokens.css', selector, name)
    const { edge, color } = material as { edge?: string; color?: string }
    expect(at('--mat-fill')).toBe(`var(--${material.fill})`)
    expect(at('--mat-hi')).toBe(`var(--${material.hi})`)
    expect(at('--mat-lo')).toBe(`var(--${material.lo})`)
    expect(at('--mat-edge')).toBe(edge === undefined ? undefined : `var(--${edge})`)
    expect(at('color')).toBe(color === undefined ? undefined : `var(--${color})`)
  })

  it.each([
    ['.m-trim', 'var(--brass-lo)'],
    ['.m-trim-lit', 'var(--brass)']
  ])('swaps only the dark edge for %s', (selector, edge) => {
    const rule = rulesIn('design-tokens.css').find((candidate) => candidate.selector === selector)
    expect([...(rule?.declarations.entries() ?? [])]).toEqual([['--mat-edge', edge]])
  })

  it('raises an overlay with a hard pixel drop shadow, not a blur', () => {
    expect(declared('design-tokens.css', '.m-raised', 'filter')).toBe(
      'drop-shadow(4px 4px 0 var(--shadow-drop))'
    )
  })

  it('draws a rule as a 2px wood line with a lit lip beside it', () => {
    const at = (name: string) => declared('design-tokens.css', '.m-rule', name)
    expect(at('height')).toBe('var(--px)')
    expect(at('background')).toBe('var(--wood-lo)')
    expect(at('box-shadow')).toBe('0 var(--px) 0 0 var(--wood-hi)')
    expect(at('border')).toBe('0')
    expect(at('margin')).toBe('0')
    const vertical = (name: string) => declared('design-tokens.css', '.m-rule-v', name)
    expect(vertical('width')).toBe('var(--px)')
    expect(vertical('align-self')).toBe('stretch')
    expect(vertical('background')).toBe('var(--wood-lo)')
    expect(vertical('box-shadow')).toBe('var(--px) 0 0 0 var(--wood-hi)')
  })

  it('sets two brass rivets at a plate’s top corners', () => {
    const pair = '.m-rivets::before, .m-rivets::after'
    const at = (name: string) => declared('design-tokens.css', pair, name)
    expect(declared('design-tokens.css', '.m-rivets', 'position')).toBe('relative')
    // An empty string either way: the formatter owns the quote style.
    expect(at('content')).toMatch(/^(""|'')$/)
    expect(at('position')).toBe('absolute')
    expect(at('top')).toBe('4px')
    expect(at('width')).toBe('var(--px)')
    expect(at('height')).toBe('var(--px)')
    expect(at('background')).toBe('var(--brass-lo)')
    expect(at('box-shadow')).toBe('0 var(--px) 0 0 var(--rock-lo)')
    expect(at('pointer-events')).toBe('none')
    expect(declared('design-tokens.css', '.m-rivets::before', 'left')).toBe('4px')
    expect(declared('design-tokens.css', '.m-rivets::after', 'right')).toBe('4px')
  })
})

describe('design-tokens.css spacing, hit targets and layers (#635)', () => {
  it.each([
    ['--sp-1', '2px'],
    ['--sp-2', '4px'],
    ['--sp-3', '8px'],
    ['--sp-4', '12px'],
    ['--sp-5', '16px'],
    ['--sp-6', '24px'],
    ['--hit', '32px'],
    ['--hit-tool', '36px'],
    ['--hit-nav', '40px'],
    ['--row', '40px']
  ])('carries the spacing token %s as %s', (name, value) => {
    expect(rootToken(name)).toBe(value)
  })

  // Stacked in the order the layers sit, each above the one before it.
  it.each([
    ['--z-float', '20'],
    ['--z-overlay', '50'],
    ['--z-menu', '60'],
    ['--z-dialog', '80'],
    ['--z-toast', '90']
  ])('carries the layer %s as %s', (name, value) => {
    expect(rootToken(name)).toBe(value)
  })

  it('pads a plate by the scale, never by a literal', () => {
    expect(declared('design-tokens.css', '.m-plate', 'padding')).toBe('var(--sp-2) var(--sp-3)')
  })

  /*
   * The whole-art-pixel rule: every gap, padding, margin and size is a whole number of 2px art
   * pixels, so an edge never lands between screen pixels at 1x. Type sizes are exempt — a face is
   * sharp at multiples of its own em grid (Jacquard 12 at 21px), which the crisp-size rule governs.
   *
   * The v4 sizes below predate the rule and are retired by the rebuild slice that replaces their
   * callers, not re-valued here by guesswork. The list may only shrink: each entry must still be
   * odd, so a token fixed in place has to leave it.
   */
  const LEGACY_V4_ODD_SIZES = [
    '--space-map-pad',
    '--size-icon',
    '--size-sleep-icon',
    '--size-chip-height',
    '--size-mine-interior-width',
    '--size-feature-panel-width',
    '--size-message-input-width'
  ]
  const isTypeSize = (name: string) => name.startsWith('--fs-') || name.startsWith('--text-')
  const pixelsIn = (value: string) =>
    [...value.matchAll(/(-?\d*\.?\d+)px/g)].map((match) => Number(match[1]))

  it('draws every size and spacing in design-tokens.css in whole 2px art pixels', () => {
    const offenders: string[] = []
    for (const rule of rulesIn('design-tokens.css')) {
      for (const [name, value] of rule.declarations) {
        if (isTypeSize(name) || LEGACY_V4_ODD_SIZES.includes(name)) continue
        if (pixelsIn(value).some((px) => px % 2 !== 0)) {
          offenders.push(`${rule.selector} ${name}: ${value}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it.each(LEGACY_V4_ODD_SIZES)('still lists %s only because it is still off the grid', (name) => {
    const value = rootToken(name)
    expect(value).toBeTruthy()
    expect(pixelsIn(value!).some((px) => px % 2 !== 0)).toBe(true)
  })
})
