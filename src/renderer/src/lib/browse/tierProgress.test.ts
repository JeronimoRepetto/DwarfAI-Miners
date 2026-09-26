import { describe, expect, it } from 'vitest'
import { tierProgress } from './tierProgress'

describe('tierProgress', () => {
  it('fills toward the next tier in its colour, the fill a three-place fraction', () => {
    expect(tierProgress({ value: 1630, max: 2048, nextTier: 'gold' })).toEqual({
      kind: 'toward',
      tier: 'gold',
      lead: 'Next: ',
      tierLabel: 'Gold',
      numbers: '1,630 / 2,048',
      fill: '0.796',
      bar: { min: 0, max: 2048, now: 1630, label: 'Progress to Gold' }
    })
    expect(tierProgress({ value: 12, max: 100, nextTier: 'copper' }).fill).toBe('0.120')
  })

  it('takes its own lead-in in place of "Next: "', () => {
    expect(tierProgress({ value: 1, max: 2, nextTier: 'silver', label: 'To ' }).lead).toBe('To ')
  })

  it('never fills past its ends', () => {
    expect(tierProgress({ value: 300, max: 100, nextTier: 'gold' }).fill).toBe('1.000')
    expect(tierProgress({ value: -5, max: 100, nextTier: 'gold' }).fill).toBe('0.000')
    expect(tierProgress({ value: 5, max: 0, nextTier: 'gold' }).fill).toBe('0.000')
  })

  it('shows a scan and no value while measuring', () => {
    expect(tierProgress({ measuring: true })).toEqual({
      kind: 'measuring',
      title: 'Measuring…',
      numbers: '—'
    })
  })

  it('shows "Max tier" and the value, with no bar, at the top tier', () => {
    expect(tierProgress({ value: 9412, maxTier: true })).toEqual({
      kind: 'max',
      title: 'Max tier',
      numbers: '9,412'
    })
  })
})
