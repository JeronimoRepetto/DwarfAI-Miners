import { describe, expect, it } from 'vitest'
import { buttonAttributes, buttonClasses, buttonIconScale, isIconOnly } from './button'

describe('buttonClasses', () => {
  it('is a control-wood plate by default: the button class and the material recipe', () => {
    expect(buttonClasses({ label: 'History' })).toEqual(['dm-btn', 'm-mat'])
  })

  it('names the variant, then the size, then the icon-only shape, in the kit order', () => {
    expect(buttonClasses({ label: 'Go', variant: 'primary', size: 'lg' })).toEqual([
      'dm-btn',
      'm-mat',
      'dm-btn--primary',
      'dm-btn--lg'
    ])
    expect(buttonClasses({ icon: 'more', title: 'More', size: 'sm' })).toEqual([
      'dm-btn',
      'm-mat',
      'dm-btn--sm',
      'dm-btn--icon'
    ])
  })

  it('stretches a block button', () => {
    expect(buttonClasses({ label: 'Go', block: true })).toContain('dm-btn--block')
  })

  it('forces a state look with its is- class, last', () => {
    for (const state of ['hover', 'active', 'focus'] as const) {
      expect(buttonClasses({ label: 'Go', variant: 'danger', state }).at(-1)).toBe('is-' + state)
    }
  })

  it('is icon-only only when it has an icon and no label', () => {
    expect(isIconOnly({ icon: 'send', label: 'Send' })).toBe(false)
    expect(isIconOnly({ icon: 'send' })).toBe(true)
    expect(isIconOnly({ label: 'Send' })).toBe(false)
    expect(buttonClasses({ icon: 'send', label: 'Send' })).not.toContain('dm-btn--icon')
  })
})

describe('buttonIconScale', () => {
  it('draws the glyph at 2x in a 36px icon-only button, and 1x in a small one', () => {
    expect(buttonIconScale({ icon: 'history', title: 'History' })).toBe(2)
    expect(buttonIconScale({ icon: 'more', title: 'More', size: 'sm' })).toBe(1)
  })

  it('draws the glyph at 1x beside a label', () => {
    expect(buttonIconScale({ icon: 'send', label: 'Send' })).toBe(1)
  })

  it('takes an explicit scale over the default', () => {
    expect(buttonIconScale({ icon: 'send', label: 'Send', iconScale: 2 })).toBe(2)
  })
})

describe('buttonAttributes', () => {
  it('is a plain button unless told otherwise, so it never submits a form by accident', () => {
    expect(buttonAttributes({ label: 'Go' }).type).toBe('button')
    expect(buttonAttributes({ label: 'Go', type: 'submit' }).type).toBe('submit')
  })

  it('makes an icon-only button title its accessible name as well as its tooltip', () => {
    expect(buttonAttributes({ icon: 'close', title: 'Close' })).toMatchObject({
      title: 'Close',
      'aria-label': 'Close'
    })
  })

  it('leaves a labelled button named by its label, its title only a tooltip', () => {
    const attributes = buttonAttributes({ label: 'History', title: 'Open the history' })
    expect(attributes.title).toBe('Open the history')
    expect(attributes['aria-label']).toBeUndefined()
  })

  it('states aria-pressed only for a toggle, both ways', () => {
    expect(buttonAttributes({ label: 'Pinned' })['aria-pressed']).toBeUndefined()
    expect(buttonAttributes({ label: 'Pinned', pressed: false })['aria-pressed']).toBe('false')
    expect(buttonAttributes({ label: 'Pinned', pressed: true })['aria-pressed']).toBe('true')
  })

  it('marks a menu opener', () => {
    expect(buttonAttributes({ icon: 'more', title: 'More', haspopup: 'menu' })).toMatchObject({
      'aria-haspopup': 'menu'
    })
    expect(buttonAttributes({ label: 'Go' })['aria-haspopup']).toBeUndefined()
  })

  it('disables the native button', () => {
    expect(buttonAttributes({ label: 'Go', disabled: true }).disabled).toBe(true)
    expect(buttonAttributes({ label: 'Go' }).disabled).toBe(false)
  })
})
