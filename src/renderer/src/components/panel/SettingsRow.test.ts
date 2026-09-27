// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import KeyCap from './KeyCap.vue'
import SettingsBanner from './SettingsBanner.vue'
import SettingsRow from './SettingsRow.vue'

/**
 * The settings row molecule (#635), `molecules/settings-row`: label and help on the left, the
 * control on the right; stacked, danger zone, the warning banner and the key cap as its variants.
 * Its pixels are graded by the goldens; these pin what the pixels cannot show.
 */
describe('SettingsRow', () => {
  it('draws its label, its help, and the control it was handed', () => {
    const wrapper = mount(SettingsRow, {
      props: { label: 'Always on top', help: 'Keeps the panel above other windows.' },
      slots: { default: '<button class="the-control">x</button>' }
    })
    expect(wrapper.get('.dm-srow__label').text()).toBe('Always on top')
    expect(wrapper.get('.dm-srow__help').text()).toBe('Keeps the panel above other windows.')
    expect(wrapper.find('.dm-srow__control .the-control').exists()).toBe(true)
  })

  it('draws no help line when it has none, rather than an empty paragraph', () => {
    const wrapper = mount(SettingsRow, { props: { label: 'Music' } })
    expect(wrapper.find('.dm-srow__help').exists()).toBe(false)
  })

  it('hands the control the ids of its label and help, so the control can point at them', () => {
    const wrapper = mount(SettingsRow, {
      props: { label: 'Panel shortcut', help: 'Shows and hides everything.' },
      slots: {
        default: `<template #default="{ labelId, helpId }">
          <button :aria-labelledby="labelId" :aria-describedby="helpId">x</button>
        </template>`
      }
    })
    const button = wrapper.get('button')
    expect(wrapper.get(`#${button.attributes('aria-labelledby')}`).text()).toBe('Panel shortcut')
    expect(wrapper.get(`#${button.attributes('aria-describedby')}`).text()).toBe(
      'Shows and hides everything.'
    )
  })

  it('stacks and wears the danger zone only when asked', () => {
    expect(mount(SettingsRow, { props: { label: 'a' } }).classes()).toEqual(['dm-srow'])
    expect(
      mount(SettingsRow, { props: { label: 'a', stack: true, tone: 'danger' } }).classes()
    ).toEqual(['dm-srow', 'dm-srow--danger', 'dm-srow--stack'])
  })

  it('draws the notes it is handed under the help, beside the text rather than the control', () => {
    const wrapper = mount(SettingsRow, {
      props: { label: 'Jev', help: 'Your key.' },
      slots: { notes: '<p class="dm-srow__help" role="alert">It did not take.</p>' }
    })
    const helps = wrapper.findAll('.dm-srow__help')
    expect(helps.map((help) => help.text())).toEqual(['Your key.', 'It did not take.'])
    expect(wrapper.find('.dm-srow__control [role="alert"]').exists()).toBe(false)
  })
})

describe('SettingsBanner', () => {
  it('announces its one line as an alert, behind a warning glyph', () => {
    const wrapper = mount(SettingsBanner, { props: { text: 'Ctrl+P is already in use.' } })
    expect(wrapper.attributes('role')).toBe('alert')
    expect(wrapper.text()).toBe('Ctrl+P is already in use.')
    expect(wrapper.find('.dm-icon').exists()).toBe(true)
  })
})

describe('KeyCap', () => {
  it('draws a recorded shortcut as a plain key cap', () => {
    const wrapper = mount(KeyCap, { slots: { default: 'Ctrl+Alt+Shift+P' } })
    expect(wrapper.element.tagName).toBe('SPAN')
    expect(wrapper.classes()).toEqual(['dm-kbd'])
    expect(wrapper.text()).toBe('Ctrl+Alt+Shift+P')
  })

  it('is a real button when asked, passing every attribute and listener through', async () => {
    let clicks = 0
    const wrapper = mount(KeyCap, {
      props: { button: true },
      attrs: { 'aria-pressed': 'true', onClick: () => clicks++ },
      slots: { default: 'Ctrl+P' }
    })
    expect(wrapper.element.tagName).toBe('BUTTON')
    expect(wrapper.attributes('type')).toBe('button')
    expect(wrapper.attributes('aria-pressed')).toBe('true')
    await wrapper.trigger('click')
    expect(clicks).toBe(1)
  })
})
