// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { PORTRAIT_SRC } from '../../lib/art'
import DwarfPortrait from './DwarfPortrait.vue'

describe('DwarfPortrait', () => {
  it('is a static figure by default: the face with empty alt, then the hidden mark', () => {
    const portrait = mount(DwarfPortrait, { props: { role: 'foreman' } })
    expect(portrait.element.tagName).toBe('SPAN')
    expect(portrait.attributes('data-status')).toBe('idle')
    expect(portrait.attributes('aria-label')).toBeUndefined()
    const [face, mark] = [...portrait.element.children]
    expect(face!.tagName).toBe('IMG')
    expect(face!.getAttribute('src')).toBe(PORTRAIT_SRC.foreman)
    expect(face!.getAttribute('alt')).toBe('')
    expect(mark!.className).toBe('dm-portrait__mark')
    expect(mark!.getAttribute('aria-hidden')).toBe('true')
    expect(mark!.textContent).toBe('')
  })

  it('is a named button when interactive, marking its status and reporting a click', async () => {
    const portrait = mount(DwarfPortrait, {
      props: { role: 'worker2', status: 'asking', name: 'b', interactive: true }
    })
    expect(portrait.element.tagName).toBe('BUTTON')
    expect(portrait.attributes('aria-label')).toBe('b, needs you')
    expect(portrait.attributes('aria-pressed')).toBe('false')
    expect(portrait.get('.dm-portrait__mark').text()).toBe('?')
    await portrait.trigger('click')
    expect(portrait.emitted('click')).toHaveLength(1)
  })

  it('swaps its mark in place when the status changes', async () => {
    const portrait = mount(DwarfPortrait, { props: { role: 'worker', status: 'working' } })
    await portrait.setProps({ status: 'asleep' })
    expect(portrait.attributes('data-status')).toBe('asleep')
    expect(portrait.get('.dm-portrait__mark').text()).toBe('z')
  })
})
