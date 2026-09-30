import { describe, expect, it } from 'vitest'
import { dialogClasses, trapTab, typedMatches, typedPlaceholder, typedPrompt } from './dialog'

describe('dialogClasses', () => {
  it('is a raised wood card, with the danger and wide variants in the kit order', () => {
    expect(dialogClasses({})).toEqual(['dm-dialog', 'm-mat', 'm-raised'])
    expect(dialogClasses({ danger: true, wide: true })).toEqual([
      'dm-dialog',
      'm-mat',
      'm-raised',
      'dm-dialog--danger',
      'dm-dialog--wide'
    ])
  })

  it('marks a card drawn in place, outside a scrim, as the UI kit states draw it', () => {
    expect(dialogClasses({ danger: true, static: true })).toEqual([
      'dm-dialog',
      'm-mat',
      'm-raised',
      'dm-dialog--danger',
      'dm-dialog--static'
    ])
  })
})

describe('typed confirmation', () => {
  it('asks for the word in the prompt and the placeholder', () => {
    expect(typedPrompt('yes')).toBe('Type "yes" to confirm')
    expect(typedPlaceholder('yes')).toBe('Type "yes"')
  })

  it('matches the word trimmed and in any case, and nothing else', () => {
    expect(typedMatches('  YeS ', 'yes')).toBe(true)
    expect(typedMatches('ye', 'yes')).toBe(false)
    expect(typedMatches('yes please', 'yes')).toBe(false)
  })
})

describe('trapTab', () => {
  it('moves forward and back, and wraps inside the dialog at both ends', () => {
    expect(trapTab(3, 0, false)).toBe(1)
    expect(trapTab(3, 2, false)).toBe(0)
    expect(trapTab(3, 0, true)).toBe(2)
  })

  it('starts from the first control when focus is not inside the dialog', () => {
    expect(trapTab(3, -1, false)).toBe(0)
    expect(trapTab(3, -1, true)).toBe(2)
  })

  it('has nowhere to go in a dialog with no control', () => {
    expect(trapTab(0, -1, false)).toBeUndefined()
  })
})
