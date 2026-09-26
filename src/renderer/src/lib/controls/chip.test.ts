import { describe, expect, it } from 'vitest'
import { chipAttributes, chipClasses, metaChipTitle } from './chip'

describe('chipClasses', () => {
  it('is a control-wood chip: the chip class and the material recipe', () => {
    expect(chipClasses({ label: 'All' })).toEqual(['dm-chip', 'm-mat'])
  })

  it('forces a state look with its is- class, last', () => {
    for (const state of ['hover', 'active', 'focus'] as const) {
      expect(chipClasses({ label: 'All', state })).toEqual(['dm-chip', 'm-mat', 'is-' + state])
    }
  })
})

describe('chipAttributes', () => {
  it('is a plain button that states no pressed state until it is a toggle', () => {
    expect(chipAttributes({ label: 'All' })).toEqual({ type: 'button', disabled: false })
  })

  it('toggles with aria-pressed, either way', () => {
    expect(chipAttributes({ label: 'All', pressed: true })['aria-pressed']).toBe('true')
    expect(chipAttributes({ label: 'Gold', pressed: false })['aria-pressed']).toBe('false')
  })

  it('takes role radio with aria-checked inside a radiogroup, and no aria-pressed', () => {
    const attributes = chipAttributes({ label: 'Right', role: 'radio', pressed: true })
    expect(attributes.role).toBe('radio')
    expect(attributes['aria-checked']).toBe('true')
    expect(attributes).not.toHaveProperty('aria-pressed')
    expect(chipAttributes({ label: 'Left', role: 'radio' })['aria-checked']).toBe('false')
  })

  it('carries its tier, whose colour its gem takes', () => {
    expect(chipAttributes({ label: 'Copper', tier: 'copper' })['data-tier']).toBe('copper')
  })

  it('disables the native button', () => {
    expect(chipAttributes({ label: 'Other…', disabled: true }).disabled).toBe(true)
  })
})

describe('metaChipTitle', () => {
  it('is the fact itself unless a title is given, so a cut fact can still be read whole', () => {
    expect(metaChipTitle('worktree: main')).toBe('worktree: main')
    expect(metaChipTitle('worktree: main', 'Checked out in the worktree')).toBe(
      'Checked out in the worktree'
    )
  })
})
