// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import NotificationSettings from './NotificationSettings.vue'

/**
 * The Notifications section of the Settings screen (#316, the maintainer's
 * extension of `screens/settings.md` — the same gap the Audio section #174
 * added sits in, and the source file already names this one as joining it).
 *
 * Presentational like every other settings piece: the stored switch arrives as
 * a prop and the intent leaves as an event, so App.vue keeps owning the IPC and
 * the "render only what main verified" rule stays in exactly one place.
 */
function render(enabled: boolean) {
  return mount(NotificationSettings, { props: { enabled } })
}

describe('NotificationSettings — rendering', () => {
  it('names the section and its one control', () => {
    const wrapper = render(true)
    expect(wrapper.text()).toContain('Notifications')
    expect(wrapper.text()).toContain('System notifications')
  })

  it('renders the switch as a pressed control that says which state it is in', () => {
    expect(render(true).find('.notifications-enabled').attributes('aria-pressed')).toBe('true')
    expect(render(false).find('.notifications-enabled').attributes('aria-pressed')).toBe('false')
  })

  it('gives the control an accessible name of its own', () => {
    expect(render(true).find('.notifications-enabled').attributes('aria-label')).toBeTruthy()
  })

  it('says what it will notify about, so the switch is not a mystery', () => {
    // The two cases #316 admits and no others. A switch labelled only
    // "Notifications" would leave the person guessing whether every poll
    // reaches them.
    const hint = render(true).find('.hint').text()
    expect(hint).toContain('question')
    expect(hint).toContain('turn')
  })

  it('says that the mine on screen is never announced', () => {
    expect(render(true).find('.hint').text().toLowerCase()).toContain('on screen')
  })
})

describe('NotificationSettings — changing it', () => {
  it('asks for the opposite state when the control is pressed', async () => {
    const wrapper = render(true)
    await wrapper.find('.notifications-enabled').trigger('click')
    expect(wrapper.emitted('change')).toEqual([[false]])
  })

  it('asks to turn it back on from off', async () => {
    const wrapper = render(false)
    await wrapper.find('.notifications-enabled').trigger('click')
    expect(wrapper.emitted('change')).toEqual([[true]])
  })

  it('renders only what it was given, never what it just asked for', async () => {
    // The same rule AudioSettings and PositionSettings hold: main stores and
    // answers, and the control must show the state in force rather than the
    // press that asked for it.
    const wrapper = render(true)
    await wrapper.find('.notifications-enabled').trigger('click')
    expect(wrapper.find('.notifications-enabled').attributes('aria-pressed')).toBe('true')
  })
})
