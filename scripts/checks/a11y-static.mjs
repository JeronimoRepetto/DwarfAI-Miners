#!/usr/bin/env node
/**
 * L12 static accessibility audit of the renderer (ISSUE-266; testing strategy `17` §1.12).
 *
 * Three checks, each read from the stylesheets the renderer ships (the design tokens, the base rules and every
 * component's `<style>` block), never from a running app:
 *
 * - **Contrast (NFR-A11Y-07).** WCAG 2's ratio for every text and surface pair in use: the design's register of the
 *   pairs it paints (`DESIGN_PAIRS`, transcribed from the design's foundations, Contrast), plus every rule of ours
 *   that sets both a text colour and its own ground. Body text needs 4.5:1, large text 3:1; a disabled control is
 *   exempt from the text floor (WCAG 1.4.3), so it is measured and never fails. A colour that is not one solid value
 *   (a translucent layer, a gradient, a per-tier variable set elsewhere) is not measured here.
 * - **Hit targets (NFR-A11Y-12).** The size of every control the component specs give a size to (`HIT_TARGETS`),
 *   resolved through the tokens: 32px at least, 40px for primary navigation. The space between neighbouring controls
 *   (`SIBLING_GAPS`), the container's gap plus each control's own margin: 8px, 6px for stacked nav slots and vertical
 *   tabs. What the pinned design itself specifies below a floor is a finding to report (`HIT_TARGET_FINDINGS`), never
 *   silently passed and never resized here.
 * - **Focus (NFR-A11Y-01).** One treatment: a 2px parchment outline on `:focus-visible` only, and no focus rule
 *   changes an element's size. The few rules the design specifies otherwise are listed with their source
 *   (`FOCUS_EXCEPTIONS`).
 *
 * Usage: node scripts/checks/a11y-static.mjs [<repository root>]
 * Exit code 0 when every check passes, 1 with each failure on stderr otherwise.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The renderer source root, relative to the repository root. */
const RENDERER = path.join('src', 'renderer', 'src')

/** The stylesheets that declare tokens, in cascade order (`main.ts` imports them in this order). */
const TOKEN_SHEETS = ['assets/theme.css', 'assets/design-tokens.css', 'assets/base.css']

/**
 * The design's contrast register: every text and surface pair the design paints, as `[text, ground, size]`, where
 * size is `body` (4.5:1), `large` (3:1) or `disabled` (exempt). Transcribed from the design's foundations, Contrast
 * ("72 registered pairs · 0 below their floor"); a pair whose token is missing fails, since the register says it is
 * in use.
 */
export const DESIGN_PAIRS = [
  ['--danger-ink', '--parch-lo', 'body'],
  ['--ink-on-light-soft', '--gold', 'body'],
  ['--ink-faint', '--wood-hi', 'body'],
  ['--parch-hi', '--danger-badge', 'body'],
  ['--parchment', '--gold-select', 'body'],
  ['--ink-faint', '--wood', 'body'],
  ['--ink-faint', '--wood', 'disabled'],
  ['--ink-on-light-soft', '--parch-lo', 'body'],
  ['--ink-on-light-soft', '--brass', 'body'],
  ['--parch-hi', '--gold-select', 'body'],
  ['--ink-faint', '--wood-lo', 'body'],
  ['--ink-faint', '--rock', 'disabled'],
  ['--ink-faint', '--rock', 'body'],
  ['--ink-faint', '--rock-lo', 'body'],
  ['--gold', '--wood-hi', 'body'],
  ['--ink-on-light-soft', '--parchment', 'body'],
  ['--danger-hi', '--tier-copper-lo', 'body'],
  ['--tier-uranium', '--tier-uranium-lo', 'body'],
  ['--ok', '--ok-lo', 'body'],
  ['--info', '--info-lo', 'body'],
  ['--warn', '--warn-lo', 'body'],
  ['--danger-hi', '--danger-lo', 'body'],
  ['--ink-soft', '--wood-hi', 'body'],
  ['--ink-on-light', '--gold', 'body'],
  ['--gold', '--wood', 'body'],
  ['--gold', '--wood', 'large'],
  ['--danger-hi', '--wood', 'body'],
  ['--tier-silver', '--tier-silver-lo', 'body'],
  ['--tier-uranium', '--wood', 'body'],
  ['--ok-lo', '--parch-lo', 'body'],
  ['--ink-on-light', '--info', 'body'],
  ['--gold', '--wood-lo', 'body'],
  ['--ok', '--wood', 'body'],
  ['--ink-soft', '--danger-lo', 'body'],
  ['--danger-hi', '--rock', 'body'],
  ['--tier-bronze', '--tier-bronze-lo', 'body'],
  ['--tier-bronze', '--tier-bronze-lo', 'disabled'],
  ['--ink-soft', '--wood', 'body'],
  ['--ink-soft', '--control', 'body'],
  ['--tier-uranium', '--rock', 'body'],
  ['--tier-gold', '--tier-gold-lo', 'body'],
  ['--danger-hi', '--rock-lo', 'body'],
  ['--ink-soft', '--wood-lo', 'body'],
  ['--ink-on-light', '--parch-lo', 'body'],
  ['--ink-on-light', '--brass', 'body'],
  ['--brass', '--wood', 'body'],
  ['--ink-soft', '--rock', 'body'],
  ['--ok', '--rock-lo', 'body'],
  ['--ink-soft', '--rock-lo', 'body'],
  ['--ink', '--wood-hi', 'body'],
  ['--brass', '--wood-lo', 'body'],
  ['--parchment', '--wood-hi', 'body'],
  ['--parch-lo', '--rock', 'body'],
  ['--brass', '--rock', 'body'],
  ['--brass', '--rock', 'disabled'],
  ['--parchment', '--warn-lo', 'body'],
  ['--ink-on-light', '--brass-hi', 'body'],
  ['--rock-lo', '--brass', 'body'],
  ['--brass', '--rock-lo', 'body'],
  ['--parch-hi', '--wood-hi', 'body'],
  ['--ink', '--wood', 'body'],
  ['--ink', '--control', 'body'],
  ['--parchment', '--wood', 'body'],
  ['--ink-on-light', '--parchment', 'body'],
  ['--ink', '--wood-lo', 'body'],
  ['--brass-hi', '--rock-lo', 'body'],
  ['--ink', '--rock', 'body'],
  ['--parchment', '--wood-lo', 'body'],
  ['--ink', '--rock-lo', 'body'],
  ['--parchment', '--rock', 'body'],
  ['--parchment', '--rock-lo', 'body'],
  ['--parch-hi', '--rock', 'body']
]

/** The WCAG 2 floors: body text, and large text (24px, or 18.66px bold) and UI parts. */
const BODY_FLOOR = 4.5
const LARGE_FLOOR = 3

/** The hit-target floors of NFR-A11Y-12. */
const HIT_FLOOR = 32
const NAV_FLOOR = 40

/**
 * Every control the component specs size, as `[file, selector, property, kind]`: `nav` for primary navigation (40px),
 * `control` for everything else (32px). The file is relative to the renderer root, the selector exactly as the
 * component's stylesheet writes it, and the property is read through the tokens.
 */
export const HIT_TARGETS = [
  ['components/controls/ActionButton.vue', '.dm-btn', 'min-height', 'control'],
  ['components/controls/ActionButton.vue', '.dm-btn', 'min-width', 'control'],
  ['components/controls/ActionButton.vue', '.dm-btn--lg', 'min-height', 'control'],
  ['components/controls/ActionButton.vue', '.dm-btn--icon', 'width', 'control'],
  ['components/controls/ActionButton.vue', '.dm-btn--icon', 'height', 'control'],
  ['components/controls/chip.css', '.dm-chip', 'min-height', 'control'],
  ['components/controls/InputField.vue', '.dm-field', 'min-height', 'control'],
  ['components/controls/SelectField.vue', '.dm-select', 'min-height', 'control'],
  ['components/controls/ToggleSwitch.vue', '.dm-toggle', 'min-height', 'control'],
  ['components/controls/VolumeSlider.vue', '.dm-slider', 'min-height', 'control'],
  ['components/shell/NavSlot.vue', '.dm-slot', 'width', 'nav'],
  ['components/shell/NavSlot.vue', '.dm-slot', 'height', 'nav'],
  ['components/map/TierMarker.vue', '.dm-marker', 'width', 'control'],
  ['components/map/TierMarker.vue', '.dm-marker', 'height', 'control'],
  ['components/overlay/MenuList.vue', '.dm-menu__item', 'min-height', 'control'],
  ['components/message/ActivityDisclosure.vue', '.dm-activity__toggle', 'min-height', 'control'],
  ['components/message/QuestionOption.vue', '.dm-qopt', 'min-height', 'control'],
  ['components/panel/SettingsPanel.vue', '.dm-settings__tab', 'min-height', 'control'],
  ['components/panel/TypographySettings.vue', '.dm-fontstyle__opt', 'min-height', 'control']
]

/**
 * Neighbouring controls and the space between them, as `[file, container, child file, child selector, kind]`: the
 * container's gap plus the child's margin on both sides. `stacked` (nav slots, vertical tabs) needs 6px, `row` 8px.
 */
export const SIBLING_GAPS = [
  [
    'components/shell/PanelNav.vue',
    '.dm-nav__group',
    'components/shell/NavSlot.vue',
    '.dm-slot',
    'stacked'
  ],
  [
    'components/panel/SettingsPanel.vue',
    '.dm-settings__nav',
    'components/panel/SettingsPanel.vue',
    '.dm-settings__tab',
    'stacked'
  ],
  [
    'components/overlay/DialogCard.vue',
    '.dm-dialog__actions',
    'components/controls/ActionButton.vue',
    '.dm-btn',
    'row'
  ],
  [
    'components/panel/SegmentedChoice.vue',
    '.dm-seg',
    'components/controls/chip.css',
    '.dm-chip',
    'row'
  ],
  [
    'components/panel/TypographySettings.vue',
    '.dm-fontstyle',
    'components/panel/TypographySettings.vue',
    '.dm-fontstyle__opt',
    'row'
  ],
  [
    'components/browse/MinesList.vue',
    '.dm-mines__chips',
    'components/controls/chip.css',
    '.dm-chip',
    'row'
  ],
  [
    'components/scene/MineColumn.vue',
    '.dm-minecol__bar',
    'components/controls/ActionButton.vue',
    '.dm-btn',
    'row'
  ]
]

/**
 * Sizes the pinned design itself specifies below a floor of NFR-A11Y-12. Reported to design, not resized here
 * (ISSUE-266, "Out of scope"); each must still be true, so a fix shows up as a stale finding to remove.
 */
export const HIT_TARGET_FINDINGS = [
  {
    where: 'components/controls/InputField.vue .dm-field__clear width',
    source: 'components.md, .dm-field__clear: width 24px; height 24px (inside a 32px field)'
  },
  {
    where: 'components/browse/MinesList.vue .dm-mines__chips gap',
    source:
      'components.md, .dm-mines__chips: gap 0 2px, each .dm-chip margin 2px (6px between chips)'
  },
  {
    where: 'components/scene/MineColumn.vue .dm-minecol__bar gap',
    source:
      'components.md, .dm-minecol__bar: gap 2px, each .dm-btn margin 2px (6px between buttons)'
  }
]

/** Where a finding is measured: the clear button, below the control floor. */
const FINDING_SIZES = [
  ['components/controls/InputField.vue', '.dm-field__clear', 'width', 'control']
]

/**
 * Focus rules the design specifies apart from the one treatment, as `[file, selector, source]`: a menu row or a
 * picker row lights its whole row instead of drawing a ring, and a few parts move the ring's offset. Only the offset
 * or the ring's absence may differ; a size change never may.
 */
export const FOCUS_EXCEPTIONS = [
  [
    'components/overlay/MenuList.vue',
    '.dm-menu__item:hover, .dm-menu__item:focus-visible, .dm-menu__item.is-hover',
    'components.md, .dm-menu__item:focus-visible: the row lights, outline none'
  ],
  [
    'components/panel/TypographySettings.vue',
    '.dm-fontstyle__opt:focus-visible',
    'components.md, .dm-fontstyle__opt:focus-visible: outline-offset 2px'
  ],
  [
    'components/controls/VolumeSlider.vue',
    ".dm-slider input[type='range']:focus-visible",
    'components.md, .dm-slider input:focus-visible: outline-offset 2px'
  ],
  [
    'components/scene/SceneDwarf.vue',
    '.dm-dwarf:focus-visible',
    'components.md, .dm-dwarf:focus-visible: outline-offset 0'
  ],
  [
    'components/message/MarkdownBubble.vue',
    '.markdown-link:focus-visible',
    'a link inside a parchment bubble: a parchment ring 4px outside it lands on parchment and would not show (#347)'
  ]
]

/** Properties that change an element's box, which no focus rule may set. */
const SIZE_PROPERTIES =
  /^(width|height|min-width|min-height|max-width|max-height|inline-size|block-size|padding|padding-[a-z-]+|margin|margin-[a-z-]+|border|border-width|border-(top|right|bottom|left)(-width)?|font|font-size|font-weight|line-height|letter-spacing|inset|top|right|bottom|left)$/

// ---------------------------------------------------------------------------------------------------------------
// Colour

/** A colour literal as `#rrggbb`, or null for anything that is not one solid colour. */
function hexOf(value) {
  const literal = value.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(literal)
  if (short) return '#' + short[1] + short[1] + short[2] + short[2] + short[3] + short[3]
  return /^#[0-9a-f]{6}$/.test(literal) ? literal : null
}

function luminance(hex) {
  const channel = (at) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** WCAG 2's contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

// ---------------------------------------------------------------------------------------------------------------
// Stylesheets

/** The rules of a stylesheet, each with its selector, its declarations in order, and the at-rules around it. */
function rulesOf(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  const stack = []
  let buffer = ''
  for (const char of text) {
    if (char === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '))
      buffer = ''
    } else if (char === '}') {
      const prelude = stack.pop() ?? ''
      const within = stack.filter((entry) => entry.startsWith('@'))
      if (!prelude.startsWith('@') && !within.some((entry) => entry.startsWith('@keyframes'))) {
        const decls = []
        for (const part of buffer.split(';')) {
          const colon = part.indexOf(':')
          if (colon < 0) continue
          const property = part.slice(0, colon).trim().toLowerCase()
          const value = part.slice(colon + 1).trim()
          if (property) decls.push([property, value])
        }
        rules.push({ selector: prelude, decls, media: within.join(' ') })
      }
      buffer = ''
    } else buffer += char
  }
  return rules
}

/** One stylesheet of the audit: its renderer-relative file and its rules. */
export function sheetOf(file, css) {
  return { file, rules: rulesOf(css) }
}

/** The CSS of a file: a stylesheet as it is, a Vue component's `<style>` blocks joined. */
function cssOf(file, source) {
  if (!file.endsWith('.vue')) return source
  return [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1])
    .join('\n')
}

function filesUnder(dir) {
  const found = []
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(full))
    else if (/\.(css|vue)$/.test(entry.name)) found.push(full)
  }
  return found
}

/** The custom properties declared on `:root` outside any at-rule (the values a person without preferences sees). */
function rootTokens(sheets) {
  const tokens = new Map()
  for (const sheet of sheets)
    for (const rule of sheet.rules)
      if (rule.selector === ':root' && rule.media === '')
        for (const [property, value] of rule.decls)
          if (property.startsWith('--')) tokens.set(property, value)
  return tokens
}

/** The renderer's stylesheets and its root tokens, read from the repository at `root`. */
export function loadRendererStyles(root) {
  const base = path.join(root, RENDERER)
  const files = filesUnder(base)
    .map((full) => path.relative(base, full).split(path.sep).join('/'))
    .filter((file) => !file.includes('golden/'))
    .sort()
  const ordered = [
    ...TOKEN_SHEETS.filter((file) => files.includes(file)),
    ...files.filter((file) => !TOKEN_SHEETS.includes(file))
  ]
  const sheets = ordered.map((file) =>
    sheetOf(file, cssOf(file, readFileSync(path.join(base, file), 'utf8')))
  )
  return { tokens: rootTokens(sheets), sheets }
}

/** A value with every `var()` replaced through `local` then the tokens, or null when one cannot be resolved. */
function resolve(value, tokens, local = new Map(), depth = 0) {
  if (depth > 20) return null
  const at = value.indexOf('var(')
  if (at < 0) return value.trim()
  let level = 0
  let end = at + 4
  for (; end < value.length; end++) {
    if (value[end] === '(') level++
    else if (value[end] === ')') {
      if (level === 0) break
      level--
    }
  }
  const inner = value.slice(at + 4, end)
  const comma = inner.indexOf(',')
  const name = (comma < 0 ? inner : inner.slice(0, comma)).trim()
  const fallback = comma < 0 ? null : inner.slice(comma + 1)
  const found = local.get(name) ?? tokens.get(name) ?? fallback
  if (found === null || found === undefined) return null
  const replaced = resolve(found, tokens, local, depth + 1)
  if (replaced === null) return null
  return resolve(value.slice(0, at) + replaced + value.slice(end + 1), tokens, local, depth + 1)
}

/** A length in px, or null when it is not one plain px length once resolved. */
function pxOf(value, tokens, local) {
  const resolved = value === undefined ? null : resolve(value, tokens, local)
  if (resolved === null) return null
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(resolved.split(/\s+/)[0] ?? '')
  return match ? Number(match[1]) : resolved === '0' ? 0 : null
}

/** The last value a rule gives a property. */
function declared(rule, property) {
  let value
  for (const [name, entry] of rule.decls) if (name === property) value = entry
  return value
}

/** The rule-local custom properties, which a rule's own declarations resolve through first. */
function localTokens(rule) {
  return new Map(rule.decls.filter(([property]) => property.startsWith('--')))
}

// ---------------------------------------------------------------------------------------------------------------
// Contrast (NFR-A11Y-07)

/** Whether every selector of a rule is a disabled state, which WCAG exempts from the text floor. */
function isDisabledRule(selector) {
  return selector
    .split(',')
    .every((part) => /:disabled|\[disabled\]|\.is-disabled|aria-disabled/.test(part))
}

/** The ground a rule paints under its own text: its background colour, or the material fill it sets. */
function groundOf(rule) {
  const background = declared(rule, 'background-color') ?? declared(rule, 'background')
  if (background !== undefined && !/\s/.test(background.replace(/var\([^)]*\)/g, 'v')))
    return background
  return declared(rule, '--mat-fill')
}

/**
 * Every pair measured: the design's register, and each rule that sets both a text colour and a solid ground. A
 * failure names the pair, its ratio, its floor and where it is.
 */
export function auditContrast({ tokens, sheets }) {
  const failures = []
  let measured = 0
  const check = (fg, bg, size, where, local) => {
    const text = resolve(fg, tokens, local)
    const ground = resolve(bg, tokens, local)
    const textHex = text === null ? null : hexOf(text)
    const groundHex = ground === null ? null : hexOf(ground)
    if (textHex === null || groundHex === null) return false
    measured++
    if (size === 'disabled') return true
    const ratio = contrastRatio(textHex, groundHex)
    const floor = size === 'large' ? LARGE_FLOOR : BODY_FLOOR
    if (ratio < floor) failures.push({ fg, bg, ratio: Number(ratio.toFixed(2)), floor, where })
    return true
  }
  for (const [fg, bg, size] of DESIGN_PAIRS) {
    if (!check(`var(${fg})`, `var(${bg})`, size, 'design register', new Map()))
      failures.push({
        fg,
        bg,
        ratio: null,
        floor: BODY_FLOOR,
        where: 'design register (token missing)'
      })
    else {
      // The register names tokens; report a failure by them.
      const last = failures.at(-1)
      if (last && last.fg === `var(${fg})` && last.where === 'design register') {
        last.fg = fg
        last.bg = bg
      }
    }
  }
  for (const sheet of sheets)
    for (const rule of sheet.rules) {
      const color = declared(rule, 'color')
      const ground = groundOf(rule)
      if (color === undefined || ground === undefined) continue
      const fontSize = pxOf(declared(rule, 'font-size'), tokens, localTokens(rule))
      const size = isDisabledRule(rule.selector)
        ? 'disabled'
        : fontSize !== null && fontSize >= 24
          ? 'large'
          : 'body'
      check(color, ground, size, `${sheet.file} ${rule.selector}`, localTokens(rule))
    }
  return { failures, measured }
}

// ---------------------------------------------------------------------------------------------------------------
// Hit targets (NFR-A11Y-12)

/** The last rule of `file` written exactly as `selector`. */
function ruleAt(sheets, file, selector) {
  let found
  for (const sheet of sheets)
    if (sheet.file === file)
      for (const rule of sheet.rules)
        if (rule.selector === selector && rule.media === '') found = rule
  return found
}

/** The margin a rule gives one inline side, from `margin` or `margin-inline`. */
function marginOf(rule, tokens) {
  if (rule === undefined) return 0
  const margin = declared(rule, 'margin')
  if (margin === undefined) return 0
  const resolved = resolve(margin, tokens, localTokens(rule))
  if (resolved === null) return 0
  const parts = resolved.split(/\s+/)
  const inline = parts.length === 1 ? parts[0] : parts[1]
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(inline ?? '')
  return match ? Number(match[1]) : 0
}

/** The gap of a flex or grid container between its children (the column gap of a two-value gap). */
function gapOf(rule, tokens) {
  const gap = declared(rule, 'column-gap') ?? declared(rule, 'gap')
  if (gap === undefined) return 0
  const resolved = resolve(gap, tokens, localTokens(rule))
  if (resolved === null) return null
  const parts = resolved.split(/\s+/)
  const between = parts.length === 1 ? parts[0] : parts[1]
  const match = /^(\d+(?:\.\d+)?)px$/.exec(between ?? '')
  return match ? Number(match[1]) : between === '0' ? 0 : null
}

/** Every specified size and sibling space, against its floor; design findings reported apart. */
export function auditHitTargets({ tokens, sheets }) {
  const failures = []
  const findings = []
  let measured = 0
  const findingAt = new Set(HIT_TARGET_FINDINGS.map((finding) => finding.where))
  const report = (where, size, floor) => {
    if (size !== null && size >= floor) return
    if (findingAt.has(where)) findings.push({ where, size, floor })
    else failures.push({ where, size, floor })
  }
  for (const [file, selector, property, kind] of [...HIT_TARGETS, ...FINDING_SIZES]) {
    const where = `${file} ${selector} ${property}`
    const rule = ruleAt(sheets, file, selector)
    const size =
      rule === undefined ? null : pxOf(declared(rule, property), tokens, localTokens(rule))
    measured++
    report(where, size, kind === 'nav' ? NAV_FLOOR : HIT_FLOOR)
  }
  for (const [file, container, childFile, child, kind] of SIBLING_GAPS) {
    const where = `${file} ${container} gap`
    const rule = ruleAt(sheets, file, container)
    const gap = rule === undefined ? null : gapOf(rule, tokens)
    const space = gap === null ? null : gap + 2 * marginOf(ruleAt(sheets, childFile, child), tokens)
    measured++
    report(where, space, kind === 'stacked' ? 6 : 8)
  }
  return { failures, findings, measured }
}

// ---------------------------------------------------------------------------------------------------------------
// Focus (NFR-A11Y-01)

/** Whether an outline value is the one ring: 2px, solid, parchment. */
function isTheRing(value, tokens, local) {
  const resolved = resolve(value, tokens, local)
  if (resolved === null) return false
  const parts = resolved.toLowerCase().split(/\s+/)
  return (
    parts.length === 3 &&
    parts.includes('2px') &&
    parts.includes('solid') &&
    parts.some((part) => hexOf(part) === hexOf(tokens.get('--parchment') ?? ''))
  )
}

/**
 * Every rule that styles focus (`:focus`, `:focus-visible`, `:focus-within`, `.is-focus`) against the one treatment:
 * plain `:focus` may only take the outline away; a ring is the 2px parchment one; nothing changes size.
 */
export function auditFocusVisible({ tokens, sheets }) {
  const failures = []
  // The treatment itself: one base rule draws the ring on :focus-visible for every element.
  const base = sheets
    .find((sheet) => sheet.file === 'assets/base.css')
    ?.rules.find((rule) =>
      rule.selector.split(',').some((part) => part.trim() === ':focus-visible')
    )
  if (
    base === undefined ||
    !isTheRing(declared(base, 'outline') ?? '', tokens, localTokens(base)) ||
    pxOf(declared(base, 'outline-offset'), tokens, localTokens(base)) !== 4
  )
    failures.push({
      file: 'assets/base.css',
      rule: ':focus-visible',
      reason: 'the base rule does not draw the 2px parchment ring 4px outside'
    })
  const excepted = new Set(FOCUS_EXCEPTIONS.map(([file, selector]) => `${file} ${selector}`))
  for (const sheet of sheets)
    for (const rule of sheet.rules) {
      const { selector } = rule
      if (!/:focus|\.is-focus\b/.test(selector)) continue
      const local = localTokens(rule)
      const fail = (reason) => failures.push({ file: sheet.file, rule: selector, reason })
      const sizing = rule.decls.find(([property]) => SIZE_PROPERTIES.test(property))
      if (sizing) {
        fail(`sets ${sizing[0]} on focus, which changes the element's size`)
        continue
      }
      const outline = declared(rule, 'outline')
      const plainFocus = selector.split(',').some((part) => /:focus(?![-\w])/.test(part))
      if (plainFocus) {
        if (outline !== undefined && outline.trim() !== 'none' && outline.trim() !== '0')
          fail('draws a ring on plain :focus, which a mouse press shows too')
        continue
      }
      if (excepted.has(`${sheet.file} ${selector}`)) continue
      if (outline !== undefined && !isTheRing(outline, tokens, local))
        fail(`outline ${outline} is not the one 2px parchment ring`)
      const offset = declared(rule, 'outline-offset')
      if (offset !== undefined && pxOf(offset, tokens, local) !== 4)
        fail(`outline-offset ${offset} is not 4px outside the frame`)
    }
  return { failures }
}

// ---------------------------------------------------------------------------------------------------------------
// Command line

/** Runs the three audits on the repository at `root`; returns the exit code. */
export function runA11yStatic(root, io) {
  const styles = loadRendererStyles(root)
  const contrast = auditContrast(styles)
  const hits = auditHitTargets(styles)
  const focus = auditFocusVisible(styles)
  for (const failure of contrast.failures)
    io.err(
      `a11y-static: [NFR-A11Y-07] ${failure.fg} on ${failure.bg} is ${failure.ratio ?? 'unmeasurable'}:1, below ${failure.floor}:1 (${failure.where})`
    )
  for (const failure of hits.failures)
    io.err(
      `a11y-static: [NFR-A11Y-12] ${failure.where} is ${failure.size ?? 'not found'}px, below ${failure.floor}px`
    )
  for (const failure of focus.failures)
    io.err(`a11y-static: [NFR-A11Y-01] ${failure.file} ${failure.rule}: ${failure.reason}`)
  for (const finding of hits.findings)
    io.out(
      `a11y-static: design finding (reported, not resized): ${finding.where} is ${finding.size}px, below ${finding.floor}px`
    )
  const failed = contrast.failures.length + hits.failures.length + focus.failures.length
  io.out(
    `a11y-static: ${contrast.measured} contrast pairs, ${hits.measured} hit targets, ${failed} failure(s)`
  )
  return failed === 0 ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(
    process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  )
  process.exitCode = runA11yStatic(root, { out: console.log, err: console.error })
}
