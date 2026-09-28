import { describe, expect, it } from 'vitest'
import { selectClasses, selectOptions, selectedValue } from './select'

describe('selectClasses', () => {
  it('is a control-wood face: the select class and the material recipe', () => {
    expect(selectClasses({ options: ['Panel'] })).toEqual(['dm-select', 'm-mat'])
  })

  it('marks disabled, then the forced state', () => {
    expect(selectClasses({ options: ['Jev decides'], disabled: true })).toEqual([
      'dm-select',
      'm-mat',
      'is-disabled'
    ])
    for (const state of ['hover', 'focus'] as const) {
      expect(selectClasses({ options: ['Panel'], state }).at(-1)).toBe('is-' + state)
    }
  })
})

describe('selectOptions', () => {
  it('takes a plain string as both the value and the label', () => {
    expect(selectOptions(['Last used', 'Panel'])).toEqual([
      { value: 'Last used', label: 'Last used' },
      { value: 'Panel', label: 'Panel' }
    ])
  })

  it('keeps an option given as a value and a label', () => {
    expect(selectOptions([{ value: 'tiny5', label: 'Tiny5' }, 'Other'])).toEqual([
      { value: 'tiny5', label: 'Tiny5' },
      { value: 'Other', label: 'Other' }
    ])
  })
})

describe('selectedValue', () => {
  it('is the value asked for when an option has it', () => {
    expect(selectedValue({ options: ['Last used', 'Panel'], value: 'Panel' })).toBe('Panel')
  })

  it('is the first option otherwise, as a native select shows it', () => {
    expect(selectedValue({ options: ['Last used', 'Panel'] })).toBe('Last used')
    expect(selectedValue({ options: ['Last used', 'Panel'], value: 'Gone' })).toBe('Last used')
    expect(selectedValue({ options: [] })).toBe('')
  })
})
