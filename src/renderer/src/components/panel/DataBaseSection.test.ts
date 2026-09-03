// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DataBaseSection from './DataBaseSection.vue'

/**
 * The Data Base section of the redesigned Settings screen (#138,
 * screens/settings.md): the section label plus the action that opens the
 * reset-metrics confirmation modal. The modal itself is a sibling
 * (ResetMetricsModal), opened by SettingsPanel — this component only asks.
 */
describe('DataBaseSection', () => {
  it('names the section and the action', () => {
    const wrapper = mount(DataBaseSection)
    expect(wrapper.text()).toContain('Data Base')
    expect(wrapper.find('.reset-metrics').text()).toBe('Reset metrics')
  })

  it('is a real, keyboard-operable button', () => {
    const wrapper = mount(DataBaseSection)
    expect(wrapper.find('.reset-metrics').attributes('type')).toBe('button')
  })

  it('asks to open the reset modal on click', async () => {
    const wrapper = mount(DataBaseSection)
    await wrapper.find('.reset-metrics').trigger('click')
    expect(wrapper.emitted('open-reset')).toHaveLength(1)
  })
})
