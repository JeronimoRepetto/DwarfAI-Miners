// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DataBaseSection from './DataBaseSection.vue'

/**
 * The Data Base section of the redesigned Settings screen (#138,
 * screens/settings.md): the section label plus the action that opens the
 * reset-metrics confirmation. The confirmation itself is the dialog SettingsPanel
 * opens (#635; it was the ResetMetricsModal sibling) — this component only asks.
 */
describe('DataBaseSection', () => {
  // AMENDED (#635): the action is "Reset metrics…" now, its ellipsis saying it asks first
  // (screens/settings.md, As built: Data), and it stands in the danger zone.
  it('names the section and the action', () => {
    const wrapper = mount(DataBaseSection)
    expect(wrapper.text()).toContain('Data Base')
    expect(wrapper.find('.reset-metrics').text()).toBe('Reset metrics…')
    expect(wrapper.classes()).toContain('dm-srow--danger')
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
