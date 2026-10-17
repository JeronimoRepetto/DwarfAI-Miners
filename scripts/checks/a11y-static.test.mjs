import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESIGN_PAIRS,
  HIT_TARGET_FINDINGS,
  auditContrast,
  auditFocusVisible,
  auditHitTargets,
  contrastRatio,
  loadRendererStyles,
  runA11yStatic,
  sheetOf
} from './a11y-static.mjs'

/**
 * L12 static checks of the Panel (ISSUE-266; testing strategy `17` §1.12): WCAG AA contrast computed from the design
 * tokens for every text and surface pair in use (NFR-A11Y-07), hit targets from the component specs (NFR-A11Y-12), and
 * the one `:focus-visible` treatment (NFR-A11Y-01). Each case audits the repository's real stylesheets, then proves the
 * audit bites on a planted failure, so a check that stopped measuring cannot pass silently.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const styles = loadRendererStyles(REPO_ROOT)

/** The same styles with one token repointed, as a careless palette edit would. */
function withToken(name, value) {
  return { ...styles, tokens: new Map([...styles.tokens, [name, value]]) }
}

/** The same styles with one more stylesheet, as a new component would add. */
function withSheet(file, css) {
  return { ...styles, sheets: [...styles.sheets, sheetOf(file, css)] }
}

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

describe('L12 static accessibility audit (17 §1.12)', () => {
  it('[NFR-A11Y-07] every text and surface token pair in use reaches WCAG AA', () => {
    // The formula is WCAG 2's: black on white is 21:1, and a colour on itself 1:1.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#14100b', '#14100b')).toBeCloseTo(1, 5)
    // The design's register (foundations.md, Contrast) is measured whole, plus the pairs the components paint.
    expect(DESIGN_PAIRS).toHaveLength(72)
    const report = auditContrast(styles)
    expect(report.failures).toEqual([])
    expect(report.measured).toBeGreaterThan(DESIGN_PAIRS.length)

    // A text token pushed below its floor fails on every pair it is in (the load-bearing case of ISSUE-266).
    const dim = auditContrast(withToken('--ink-faint', '#5d4e3a'))
    expect(dim.failures.map((failure) => failure.fg)).toContain('--ink-faint')
    // A component rule that paints its own low-contrast pair fails too, and names its file.
    const planted = auditContrast(
      withSheet(
        'components/Planted.vue',
        '.planted { color: var(--wood-hi); background: var(--wood); }'
      )
    )
    expect(planted.failures).toEqual([
      expect.objectContaining({
        fg: 'var(--wood-hi)',
        bg: 'var(--wood)',
        where: 'components/Planted.vue .planted'
      })
    ])
    // A disabled control is exempt from the text floor (WCAG 1.4.3), so it is measured but never fails.
    const disabled = auditContrast(
      withSheet(
        'components/Planted.vue',
        '.planted:disabled { color: var(--wood-hi); background: var(--wood); }'
      )
    )
    expect(disabled.failures).toEqual([])
  })

  it('[NFR-A11Y-12] hit targets are at least 32 px, 40 px for primary navigation, with the specified sibling gaps', () => {
    const report = auditHitTargets(styles)
    expect(report.failures).toEqual([])
    expect(report.measured).toBeGreaterThan(10)
    // What the pinned design itself specifies below the floor is reported, never silently passed, and stays true.
    expect(report.findings.map((finding) => finding.where)).toEqual(
      HIT_TARGET_FINDINGS.map((finding) => finding.where)
    )

    // A primary nav slot shrunk to the plain floor fails: navigation needs 40px.
    const slot = auditHitTargets(withToken('--hit-nav', '32px'))
    expect(slot.failures.map((failure) => failure.where)).toContain(
      'components/shell/NavSlot.vue .dm-slot height'
    )
    // A control shrunk under 32px fails.
    const small = auditHitTargets(withToken('--hit', '28px'))
    expect(small.failures.map((failure) => failure.where)).toContain(
      'components/controls/ActionButton.vue .dm-btn min-height'
    )
    // Two settings tabs pushed to 4px apart fail the stacked floor of 6px.
    const tight = auditHitTargets(
      withSheet('components/panel/SettingsPanel.vue', '.dm-settings__nav { gap: 4px; }')
    )
    expect(tight.failures.map((failure) => failure.where)).toContain(
      'components/panel/SettingsPanel.vue .dm-settings__nav gap'
    )
  })

  it("[NFR-A11Y-01] focus uses one 2 px outline on :focus-visible that never changes an element's size", () => {
    expect(auditFocusVisible(styles).failures).toEqual([])

    const planted = (css) =>
      auditFocusVisible(withSheet('components/Planted.vue', css)).failures.map(
        (failure) => failure.rule
      )
    // Another colour or width of ring is a second treatment.
    expect(planted('.planted:focus-visible { outline: 3px solid var(--parchment); }')).toEqual([
      '.planted:focus-visible'
    ])
    expect(planted('.planted:focus-visible { outline: 2px solid var(--gold); }')).toEqual([
      '.planted:focus-visible'
    ])
    // Focusing never moves anything: no size, padding, margin, border or font change on focus.
    expect(planted('.planted:focus-visible { padding: 4px; }')).toEqual(['.planted:focus-visible'])
    expect(planted('.planted.is-focus { border-width: 2px; }')).toEqual(['.planted.is-focus'])
    // A ring on plain :focus would show on a mouse press too; only :focus-visible draws it.
    expect(planted('.planted:focus { outline: 2px solid var(--parchment); }')).toEqual([
      '.planted:focus'
    ])
    // A ring removed without the design saying so is a missing treatment.
    expect(planted('.planted:focus-visible { outline: none; }')).toEqual(['.planted:focus-visible'])
    // The one treatment itself, restated, passes.
    expect(
      planted('.planted:focus-visible { outline: var(--px) solid var(--parchment); }')
    ).toEqual([])
  })

  it('[NFR-A11Y-01, NFR-A11Y-07, NFR-A11Y-12] the command line passes on the repository and fails on a planted failure', () => {
    const lines = { out: [], err: [] }
    const io = { out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) }
    expect(runA11yStatic(REPO_ROOT, io)).toBe(0)
    expect(lines.err).toEqual([])

    // A minimal renderer tree whose only text pair is below the floor.
    const root = mkdtempSync(path.join(tmpdir(), 'a11y-static-'))
    tempRoots.push(root)
    const assets = path.join(root, 'src', 'renderer', 'src', 'assets')
    mkdirSync(assets, { recursive: true })
    writeFileSync(
      path.join(assets, 'design-tokens.css'),
      ':root { --rock: #14100b; --rock-hi: #221b13; }\n.dim { color: var(--rock-hi); background: var(--rock); }\n'
    )
    const failed = { out: [], err: [] }
    const failedIo = { out: (line) => failed.out.push(line), err: (line) => failed.err.push(line) }
    expect(runA11yStatic(root, failedIo)).toBe(1)
    expect(failed.err.join('\n')).toContain('.dim')
  })
})
