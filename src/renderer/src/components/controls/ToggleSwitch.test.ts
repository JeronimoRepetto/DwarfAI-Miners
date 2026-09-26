// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ToggleSwitch from './ToggleSwitch.vue'

describe('ToggleSwitch', () => {
  it('is a switch button: a track holding the knob, then its On or Off', () => {
    const toggle = mount(ToggleSwitch, { props: { label: 'Always on top' } })
    expect(toggle.element.tagName).toBe('BUTTON')
    expect(toggle.attributes('role')).toBe('switch')
    expect(toggle.attributes('type')).toBe('button')
    expect(toggle.attributes('aria-label')).toBe('Always on top')
    expect(toggle.attributes('aria-checked')).toBe('false')
    const [track, state] = [...toggle.element.children]
    expect(track!.className).toBe('dm-toggle__track m-mat')
    expect(track!.children[0]!.className).toBe('dm-toggle__knob')
    expect(state!.className).toBe('dm-toggle__state')
    expect(state!.textContent).toBe('Off')
  })

  it('turns on and off with a click, reporting each change', async () => {
    const toggle = mount(ToggleSwitch, { props: { label: 'x' } })
    await toggle.trigger('click')
    expect(toggle.attributes('aria-checked')).toBe('true')
    expect(toggle.get('.dm-toggle__state').text()).toBe('On')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-checked')).toBe('false')
    expect(toggle.emitted('update:on')).toEqual([[true], [false]])
  })

  it('follows the state its host sets', async () => {
    const toggle = mount(ToggleSwitch, { props: { label: 'x', on: true } })
    expect(toggle.attributes('aria-checked')).toBe('true')
    await toggle.setProps({ on: false })
    expect(toggle.attributes('aria-checked')).toBe('false')
  })

  it('never changes while disabled', async () => {
    const toggle = mount(ToggleSwitch, { props: { label: 'x', on: true, disabled: true } })
    expect((toggle.element as HTMLButtonElement).disabled).toBe(true)
    await toggle.trigger('click')
    expect(toggle.attributes('aria-checked')).toBe('true')
    expect(toggle.emitted('update:on')).toBeUndefined()
  })
})
