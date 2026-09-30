import { describe, expect, it } from 'vitest'
import { sliderClasses, sliderReadout, volume } from './slider'

describe('volume', () => {
  it('is a whole percentage from 0 to 100', () => {
    expect(volume(60)).toBe(60)
    expect(volume(33.6)).toBe(34)
    expect(volume(-5)).toBe(0)
    expect(volume(140)).toBe(100)
  })

  it('reads a value that is not a number as silence', () => {
    expect(volume(Number.NaN)).toBe(0)
  })
})

describe('sliderReadout', () => {
  it('shows the volume as a percentage beside the slider', () => {
    expect(sliderReadout(0)).toBe('0%')
    expect(sliderReadout(60)).toBe('60%')
    expect(sliderReadout(100)).toBe('100%')
  })
})

describe('sliderClasses', () => {
  it('is the slider class, then the forced hover', () => {
    expect(sliderClasses({ label: 'Music', value: 60 })).toEqual(['dm-slider'])
    expect(sliderClasses({ label: 'Music', value: 60, state: 'hover' })).toEqual([
      'dm-slider',
      'is-hover'
    ])
  })
})
