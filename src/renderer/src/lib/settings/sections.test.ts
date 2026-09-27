import { describe, expect, it } from 'vitest'
import { SETTINGS_SECTIONS, steppedSection } from './sections'

/**
 * Settings' sections (#635, screens/settings.md W6): seven, in place of one long scroll, listed as a
 * vertical tablist moved with the up and down arrows (components.md, Settings, Accessibility).
 */
describe('SETTINGS_SECTIONS', () => {
  it('lists the seven sections in the design order', () => {
    expect(SETTINGS_SECTIONS).toEqual([
      'General',
      'Appearance',
      'Sound',
      'Notifications',
      'Integrations',
      'Data',
      'About'
    ])
  })
})

describe('steppedSection', () => {
  it.each([
    ['General', 'ArrowDown', 'Appearance'],
    ['About', 'ArrowDown', 'General'],
    ['General', 'ArrowUp', 'About'],
    ['Data', 'ArrowUp', 'Integrations']
  ] as const)('moves from %s on %s to %s, wrapping at both ends', (from, key, to) => {
    expect(steppedSection(from, key)).toBe(to)
  })

  it.each(['ArrowLeft', 'ArrowRight', 'Enter', 'Tab'])(
    'answers nothing for %s, which a vertical tablist does not move on',
    (key) => {
      expect(steppedSection('Sound', key)).toBeUndefined()
    }
  )
})
