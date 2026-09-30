import { describe, expect, it } from 'vitest'
import { toggleAttributes, toggleClasses, toggleStateText } from './toggle'

describe('toggleClasses', () => {
  it('is the toggle class, then the forced state', () => {
    expect(toggleClasses({ label: 'Always on top' })).toEqual(['dm-toggle'])
    for (const state of ['hover', 'active', 'focus'] as const) {
      expect(toggleClasses({ label: 'x', state })).toEqual(['dm-toggle', 'is-' + state])
    }
  })
})

describe('toggleAttributes', () => {
  it('is a switch button named by its label, stating whether it is on', () => {
    expect(toggleAttributes({ label: 'Always on top' })).toEqual({
      type: 'button',
      role: 'switch',
      'aria-checked': 'false',
      'aria-label': 'Always on top',
      disabled: false
    })
    expect(toggleAttributes({ label: 'x', on: true })['aria-checked']).toBe('true')
  })

  it('disables the native button', () => {
    expect(toggleAttributes({ label: 'x', disabled: true }).disabled).toBe(true)
  })
})

describe('toggleStateText', () => {
  it('says On or Off beside the track, secondary to the switch state', () => {
    expect(toggleStateText(true)).toBe('On')
    expect(toggleStateText(false)).toBe('Off')
  })
})
