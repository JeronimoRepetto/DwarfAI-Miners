// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ActionButton from './ActionButton.vue'

describe('ActionButton', () => {
  it('is a native button carrying the material recipe, and never submits by default', () => {
    const button = mount(ActionButton, { props: { label: 'History' } })
    expect(button.element.tagName).toBe('BUTTON')
    expect(button.attributes('type')).toBe('button')
    expect(button.classes()).toEqual(expect.arrayContaining(['dm-btn', 'm-mat']))
  })

  it('draws the optional icon, then the label', () => {
    const button = mount(ActionButton, {
      props: { label: 'Send', icon: 'send', variant: 'primary' }
    })
    const parts = button.element.children
    expect(parts).toHaveLength(2)
    expect(parts[0]!.classList.contains('dm-icon')).toBe(true)
    expect(parts[0]!.getAttribute('aria-hidden')).toBe('true')
    expect(parts[0]!.getAttribute('data-icon')).toBe('send')
    expect(parts[0]!.classList.contains('dm-icon--x1')).toBe(true)
    expect(parts[1]!.className).toBe('dm-btn__label')
    expect(parts[1]!.textContent).toBe('Send')
    expect(button.classes()).toContain('dm-btn--primary')
  })

  it('has no icon part without an icon, and no label part without a label', () => {
    expect(
      mount(ActionButton, { props: { label: 'Next' } })
        .find('.dm-icon')
        .exists()
    ).toBe(false)
    const iconOnly = mount(ActionButton, { props: { icon: 'close', title: 'Close' } })
    expect(iconOnly.find('.dm-btn__label').exists()).toBe(false)
    expect(iconOnly.find('.dm-icon--x2').exists()).toBe(true)
  })

  it('names an icon-only button by its title', () => {
    const button = mount(ActionButton, { props: { icon: 'close', title: 'Close' } })
    expect(button.attributes('aria-label')).toBe('Close')
    expect(button.attributes('title')).toBe('Close')
    expect(button.classes()).toContain('dm-btn--icon')
  })

  it('states aria-pressed only when it is a toggle', () => {
    expect(mount(ActionButton, { props: { label: 'Go' } }).attributes('aria-pressed')).toBe(
      undefined
    )
    expect(
      mount(ActionButton, { props: { label: 'Pinned', pressed: false } }).attributes('aria-pressed')
    ).toBe('false')
    expect(
      mount(ActionButton, { props: { label: 'Pinned', pressed: true } }).attributes('aria-pressed')
    ).toBe('true')
  })

  it('passes a click to its listener, and a disabled one does not fire', async () => {
    const onClick = vi.fn()
    const live = mount(ActionButton, { props: { label: 'Go' }, attrs: { onClick } })
    await live.trigger('click')
    expect(onClick).toHaveBeenCalledTimes(1)

    const blocked = vi.fn()
    const disabled = mount(ActionButton, {
      props: { label: 'Go', disabled: true },
      attrs: { onClick: blocked }
    })
    expect(disabled.attributes('disabled')).toBeDefined()
    await disabled.trigger('click')
    expect(blocked).not.toHaveBeenCalled()
  })

  it('shows a forced state look through its is- class', () => {
    const button = mount(ActionButton, { props: { label: 'History', state: 'focus' } })
    expect(button.classes()).toContain('is-focus')
  })
})
