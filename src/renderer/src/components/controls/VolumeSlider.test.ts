// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import VolumeSlider from './VolumeSlider.vue'

describe('VolumeSlider', () => {
  it('is a native range named by its label, then its readout', () => {
    const slider = mount(VolumeSlider, { props: { value: 60, label: 'Music volume' } })
    expect(slider.classes()).toEqual(['dm-slider'])
    const range = slider.get('input')
    expect(range.attributes('type')).toBe('range')
    expect(range.attributes('aria-label')).toBe('Music volume')
    expect((range.element as HTMLInputElement).value).toBe('60')
    // The brass fill runs to the value along the track.
    expect((range.element as HTMLInputElement).style.getPropertyValue('--fill')).toBe('60%')
    expect(slider.get('.dm-slider__value').text()).toBe('60%')
  })

  it('moves the fill and the readout with the thumb, reporting the volume', async () => {
    const slider = mount(VolumeSlider, { props: { value: 60, label: 'Music' } })
    await slider.get('input').setValue('35')
    expect(slider.get('.dm-slider__value').text()).toBe('35%')
    expect((slider.get('input').element as HTMLInputElement).style.getPropertyValue('--fill')).toBe(
      '35%'
    )
    expect(slider.emitted('update:value')).toEqual([[35]])
  })

  it('follows a volume its host sets', async () => {
    const slider = mount(VolumeSlider, { props: { value: 10, label: 'Music' } })
    await slider.setProps({ value: 70 })
    expect(slider.get('.dm-slider__value').text()).toBe('70%')
  })

  it('disables the native range', () => {
    const slider = mount(VolumeSlider, { props: { value: 40, label: 'Voices', disabled: true } })
    expect((slider.get('input').element as HTMLInputElement).disabled).toBe(true)
  })
})
