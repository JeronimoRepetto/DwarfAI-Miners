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
 *
 * AMENDED (#635): drawn as the rows of Settings › Sound. The section's name is SettingsPanel's
 * (its tab and heading); the startup choice is a switch (aria-checked); each volume is the design's
 * slider, its native range inside the `.<channel>-volume` element, speaking whole percentages
 * while the stored volumes stay fractions of 1; the helper sentence is the Effects row's help.
 */
const range = (channel: string) => `.${channel}-volume input`
const readout = (channel: string) => `.${channel}-volume .dm-slider__value`
function render(settings: Partial<AudioPreferences> = {}) {
  return mount(AudioSettings, {
    props: { settings: { ...DEFAULT_AUDIO_PREFERENCES, ...settings } }
  })
}

describe('AudioSettings — rendering', () => {
  it('names the section and all four controls', () => {
    const wrapper = render()
    // AMENDED (#635): was toContain('Audio'); the section's name is SettingsPanel's now, and it is
    // "Sound" there (screens/settings.md, W6).
    expect(wrapper.findAll('.dm-srow__label').map((l) => l.text())).toEqual([
      'Music at startup',
      'Music',
      'Ambience',
      'Effects'
    ])
    expect(wrapper.text()).toContain('Music at startup')
    expect(wrapper.text()).toContain('Music')
    expect(wrapper.text()).toContain('Ambience')
    // AMENDED for #323 (was: 'Voices'). The same slider now scales the
    // interface sounds as well as the barks, so the row says what it does.
    expect(wrapper.text()).toContain('Effects')
    expect(wrapper.text()).not.toContain('Voices')
  })

  it('says in the helper sentence that the row covers the interface too (#323)', () => {
    // AMENDED (#635): the helper sentence is the Effects row's help line.
    expect(render().findAll('.dm-srow__help').at(-1)!.text()).toContain('interface')
  })

  // AMENDED (#635): a switch (aria-checked) now, where it was a pressed button.
  it('renders the startup choice as a pressed control that says which state it is in', () => {
    expect(
      render({ musicAtStartup: true }).find('.music-at-startup').attributes('aria-checked')
    ).toBe('true')
    expect(
      render({ musicAtStartup: false }).find('.music-at-startup').attributes('aria-checked')
    ).toBe('false')
  })

  // AMENDED (#635): the design's slider is a native 0-100 range (atoms/slider), where it was 0-1;
  // the stored fraction is drawn as its whole percentage.
  it('draws each volume as a slider over the whole range, at the stored value', () => {
    const wrapper = render({ musicVolume: 0.4, ambienceVolume: 0.6, voiceVolume: 0.8 })
    for (const [channel, value] of [
      ['music', '40'],
      ['ambience', '60'],
      ['voice', '80']
    ] as const) {
      const slider = wrapper.find(range(channel))
      expect(slider.attributes('type')).toBe('range')
      // No min or max of its own: the native range's bounds, 0 to 100, are the whole range.
      expect(slider.attributes('min')).toBeUndefined()
      expect(slider.attributes('max')).toBeUndefined()
      expect((slider.element as HTMLInputElement).value).toBe(value)
    }
  })

  it('prints each volume as a percentage, so a slider position is readable', () => {
    const wrapper = render({ musicVolume: 0.35 })
    expect(wrapper.find(readout('music')).text()).toBe('35%')
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
    // APPENDED (#635): and the held switch still shows what it was given until main answers.
    expect(wrapper.find('.music-at-startup').attributes('aria-checked')).toBe('true')
  })

  it('asks for the new volume as a fraction, one channel at a time', async () => {
    const wrapper = render()
    // AMENDED (#635): the range speaks percent, so 25 asks for the fraction 0.25.
    const slider = wrapper.find(range('ambience'))
    ;(slider.element as HTMLInputElement).value = '25'
    await slider.trigger('input')
    expect(wrapper.emitted('change')).toEqual([[{ ambienceVolume: 0.25 }]])
  })

  it('renders only what it was given, never what it just asked for', async () => {
    // The same rule PositionSettings holds: main clamps and answers, and the
    // slider must show the value in force rather than the drag that asked.
    const wrapper = render({ musicVolume: 1 })
    const slider = wrapper.find(range('music'))
    ;(slider.element as HTMLInputElement).value = '0'
    await slider.trigger('input')
    expect(wrapper.find(readout('music')).text()).toBe('100%')
  })
})
