import { describe, expect, it } from 'vitest'
import { escapeAction, fieldClasses, fieldControlAttributes, showsClear } from './input'

describe('fieldClasses', () => {
  it('is a parchment well: the field class and the material recipe', () => {
    expect(fieldClasses({ placeholder: 'Folder' })).toEqual(['dm-field', 'm-mat'])
  })

  it('marks the textarea variant, then invalid, then disabled, then the forced state', () => {
    expect(fieldClasses({ area: true })).toEqual(['dm-field', 'm-mat', 'dm-field--area'])
    expect(fieldClasses({ invalid: true })).toEqual(['dm-field', 'm-mat', 'is-invalid'])
    expect(fieldClasses({ disabled: true })).toEqual(['dm-field', 'm-mat', 'is-disabled'])
    for (const state of ['hover', 'focus'] as const) {
      expect(fieldClasses({ state })).toEqual(['dm-field', 'm-mat', 'is-' + state])
    }
  })
})

describe('fieldControlAttributes', () => {
  it('is a text input by default, named by its placeholder when it has no label', () => {
    expect(fieldControlAttributes({ placeholder: 'Project folder' })).toEqual({
      type: 'text',
      placeholder: 'Project folder',
      'aria-label': 'Project folder',
      disabled: false
    })
  })

  it('takes its name from the label before the placeholder', () => {
    expect(
      fieldControlAttributes({ placeholder: 'Optional', label: 'Dwarf name' })['aria-label']
    ).toBe('Dwarf name')
  })

  it('states no name at all when it has neither, and an empty placeholder', () => {
    const attributes = fieldControlAttributes({ value: 'lantern-docs' })
    expect(attributes).not.toHaveProperty('aria-label')
    expect(attributes.placeholder).toBe('')
  })

  it('is a search input for search, the given type otherwise', () => {
    expect(fieldControlAttributes({ search: true }).type).toBe('search')
    expect(fieldControlAttributes({ type: 'password' }).type).toBe('password')
    expect(fieldControlAttributes({ search: true, type: 'password' }).type).toBe('search')
  })

  it('gives a textarea its rows, two by default, and no type', () => {
    expect(fieldControlAttributes({ area: true })).toEqual({
      placeholder: '',
      rows: 2,
      disabled: false
    })
    expect(fieldControlAttributes({ area: true, rows: 3 }).rows).toBe(3)
  })

  it('disables the native control', () => {
    expect(fieldControlAttributes({ disabled: true }).disabled).toBe(true)
  })
})

describe('showsClear', () => {
  it('shows the clear button on a search field once it has text', () => {
    expect(showsClear({ search: true }, '')).toBe(false)
    expect(showsClear({ search: true }, 'ai-')).toBe(true)
  })

  it('never shows one on a field that is not a search', () => {
    expect(showsClear({}, 'ai-')).toBe(false)
  })
})

describe('escapeAction', () => {
  it('clears a search field with text first, and keeps the key from closing the layer', () => {
    expect(escapeAction({ search: true }, 'ai-')).toBe('clear')
  })

  it('lets Esc bubble from an empty search, or from any other field', () => {
    expect(escapeAction({ search: true }, '')).toBe('bubble')
    expect(escapeAction({}, 'text')).toBe('bubble')
    expect(escapeAction({ area: true }, 'text')).toBe('bubble')
  })
})
