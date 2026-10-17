// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TierProgress from './TierProgress.vue'
import progressSource from './TierProgress.vue?raw'

describe('TierProgress', () => {
  it('is a progress bar toward the next tier, named for it', () => {
    const progress = mount(TierProgress, { props: { value: 1630, max: 2048, nextTier: 'gold' } })
    expect(progress.classes()).toEqual(['dm-progress'])
    expect(progress.attributes('data-tier')).toBe('gold')
    expect(progress.get('.dm-progress__row').text()).toBe('Next: Gold1,630 / 2,048')
    const track = progress.get('.dm-progress__track')
    expect(track.attributes()).toMatchObject({
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '2048',
      'aria-valuenow': '1630',
      'aria-label': 'Progress to Gold'
    })
    expect(track.get('.dm-progress__fill').attributes('style')).toBe('--p: 0.796;')
  })

  it('announces measuring as a status, with a scan in place of a fill', () => {
    const progress = mount(TierProgress, { props: { measuring: true } })
    expect(progress.attributes('role')).toBe('status')
    expect(progress.attributes('data-tier')).toBeUndefined()
    expect(progress.get('.dm-progress__row b').text()).toBe('Measuring…')
    expect(progress.get('.dm-progress__num').text()).toBe('—')
    expect(progress.find('[role="progressbar"]').exists()).toBe(false)
    expect(progress.find('.dm-progress__scan').exists()).toBe(true)
  })

  it('shows "Max tier" without a bar at the top tier', () => {
    const progress = mount(TierProgress, { props: { value: 9412, maxTier: true } })
    expect(progress.classes()).toEqual(['dm-progress', 'dm-progress--max'])
    expect(progress.get('.dm-progress__row').text()).toBe('Max tier9,412')
    expect(progress.find('.dm-progress__track').exists()).toBe(false)
  })
})

/*
 * APPENDED for ISSUE-263 (US-SHELL-011.AC03; motion.md, Reduced motion: "The scan band stops",
 * d12d3fc). The stand-in is the design's own, motion.css's `animation: none !important` on the
 * band, which design-tokens.css carries for the whole window; jsdom applies no media query, so it is
 * read from there. The component's own band animates without `!important`, so that stop wins.
 */
describe('TierProgress under reduced motion (ISSUE-263)', () => {
  const tokensSource = readFileSync(
    join(import.meta.dirname, '../../assets/design-tokens.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')
  const REDUCED = '@media (prefers-reduced-motion: reduce)'
  const style = (source: string): string =>
    source.slice(source.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '')

  it('[US-SHELL-011.AC03] the tier-progress scan band does not move while a mine is measured', () => {
    const measuring = mount(TierProgress, { props: { measuring: true } })
    expect(measuring.find('.dm-progress__track .dm-progress__scan').exists()).toBe(true)

    // The window-wide reduced-motion block stops the band outright.
    const at = tokensSource.indexOf(REDUCED + ' {\n  .dm-marker__pulse')
    expect(at).toBeGreaterThan(-1)
    const block = tokensSource.slice(at, tokensSource.indexOf('\n}', at))
    const [, selectors, body] = block.slice(block.indexOf('{') + 1).match(/([^{}]+)\{([^{}]*)\}/)!
    expect(selectors!.split(',').map((selector) => selector.trim())).toContain('.dm-progress__scan')
    expect(body!.trim()).toBe('animation: none !important;')

    // Nothing in the component outranks that stop or moves the band under reduced motion.
    const own = style(progressSource)
    expect(own).toMatch(
      /\.dm-progress__scan \{[^}]*animation: dm-scan 1\.2s steps\(8, end\) infinite;/
    )
    expect(own).not.toMatch(/animation:[^;]*!important/)
    expect(own).not.toContain(REDUCED)
  })
})
