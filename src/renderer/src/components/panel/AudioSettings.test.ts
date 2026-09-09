// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { AudioPreferences } from '../../types'
import { DEFAULT_AUDIO_PREFERENCES } from '../../types'
import AudioSettings from './AudioSettings.vue'

/**
 * The Audio section of the Settings screen (#174, the maintainer's extension
 * of `screens/settings.md`): music at startup, and the three volumes #174 and
 * #173 share.
 *
 * Presentational like every other settings piece — the stored values arrive as
 * a prop and every intent leaves as an event, so App.vue keeps owning the IPC
 * and the persistence.
 */
function render(settings: Partial<AudioPreferences> = {}) {
  return mount(AudioSettings, {
    props: { settings: { ...DEFAULT_AUDIO_PREFERENCES, ...settings } }
  })
}

describe('AudioSettings — rendering', () => {
  it('names the section and all four controls', () => {
    const wrapper = render()
    expect(wrapper.text()).toContain('Audio')
    expect(wrapper.text()).toContain('Music at startup')
    expect(wrapper.text()).toContain('Music')
    expect(wrapper.text()).toContain('Ambience')
    // AMENDED for #323 (was: 'Voices'). The same slider now scales the
    // interface sounds as well as the barks, so the row says what it does.
    expect(wrapper.text()).toContain('Effects')
    expect(wrapper.text()).not.toContain('Voices')
  })

  it('says in the helper sentence that the row covers the interface too (#323)', () => {
    expect(render().find('.hint').text()).toContain('interface')
  })

  it('renders the startup choice as a pressed control that says which state it is in', () => {
    expect(
      render({ musicAtStartup: true }).find('.music-at-startup').attributes('aria-pressed')
    ).toBe('true')
    expect(
      render({ musicAtStartup: false }).find('.music-at-startup').attributes('aria-pressed')
    ).toBe('false')
  })

  it('draws each volume as a slider over the whole range, at the stored value', () => {
    const wrapper = render({ musicVolume: 0.4, ambienceVolume: 0.6, voiceVolume: 0.8 })
    for (const [selector, value] of [
      ['.music-volume', '0.4'],
      ['.ambience-volume', '0.6'],
      ['.voice-volume', '0.8']
    ] as const) {
      const slider = wrapper.find(selector)
      expect(slider.attributes('type')).toBe('range')
      expect(slider.attributes('min')).toBe('0')
      expect(slider.attributes('max')).toBe('1')
      expect((slider.element as HTMLInputElement).value).toBe(value)
    }
  })

  it('prints each volume as a percentage, so a slider position is readable', () => {
    const wrapper = render({ musicVolume: 0.35 })
    expect(wrapper.find('.music-readout').text()).toBe('35%')
  })

  it('gives every slider an accessible name of its own', () => {
    const wrapper = render()
    const names = wrapper
      .findAll('input[type="range"]')
      .map((input) => input.attributes('aria-label'))
    expect(new Set(names).size).toBe(3)
    for (const name of names) expect(name).toBeTruthy()
  })
})

describe('AudioSettings — changing something', () => {
  it('asks for the opposite startup choice when the control is pressed', async () => {
    const wrapper = render({ musicAtStartup: true })
    await wrapper.find('.music-at-startup').trigger('click')
    expect(wrapper.emitted('change')).toEqual([[{ musicAtStartup: false }]])
  })

  it('asks for the new volume as a fraction, one channel at a time', async () => {
    const wrapper = render()
    const slider = wrapper.find('.ambience-volume')
    ;(slider.element as HTMLInputElement).value = '0.25'
    await slider.trigger('input')
    expect(wrapper.emitted('change')).toEqual([[{ ambienceVolume: 0.25 }]])
  })

  it('renders only what it was given, never what it just asked for', async () => {
    // The same rule PositionSettings holds: main clamps and answers, and the
    // slider must show the value in force rather than the drag that asked.
    const wrapper = render({ musicVolume: 1 })
    const slider = wrapper.find('.music-volume')
    ;(slider.element as HTMLInputElement).value = '0'
    await slider.trigger('input')
    expect(wrapper.find('.music-readout').text()).toBe('100%')
  })
})
