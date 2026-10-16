import { describe, expect, it } from 'vitest'
import { tierProgress, type TierProgressOptions } from './tierProgress'

// The bar's own view, for reading one field of it; any other kind fails the test that asked.
const toward = (options: TierProgressOptions) => {
  const view = tierProgress(options)
  if (view.kind !== 'toward') throw new Error('expected a bar, got ' + view.kind)
  return view
}

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
    expect(toward({ value: 12, max: 100, nextTier: 'copper' }).fill).toBe('0.120')
  })

  it('takes its own lead-in in place of "Next: "', () => {
    expect(toward({ value: 1, max: 2, nextTier: 'silver', label: 'To ' }).lead).toBe('To ')
  })

  it('never fills past its ends', () => {
    expect(toward({ value: 300, max: 100, nextTier: 'gold' }).fill).toBe('1.000')
    expect(toward({ value: -5, max: 100, nextTier: 'gold' }).fill).toBe('0.000')
    expect(toward({ value: 5, max: 0, nextTier: 'gold' }).fill).toBe('0.000')
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

// ISSUE-253 (US-MINES-008): the progress row a mine card draws, over the card the Host's read
// model builds (mineCardView): the next tier and its fraction, Max tier at the top, Measuring…
// while a mine measured before is measured again.
describe('ISSUE-253 tier progress', () => {
  it('[US-MINES-008.AC01, US-MINES-008.AC02, US-MINES-008.AC03] the progress row names the next tier with its fraction, reads Max tier at Uranium and Measuring… while re-measured', () => {
    expect(toward({ value: 300, max: 500, nextTier: 'silver' })).toMatchObject({
      lead: 'Next: ',
      tierLabel: 'Silver',
      numbers: '300 / 500',
      fill: '0.600'
    })
    expect(tierProgress({ value: 9412, maxTier: true })).toMatchObject({
      kind: 'max',
      title: 'Max tier'
    })
    expect(tierProgress({ measuring: true })).toMatchObject({
      kind: 'measuring',
      title: 'Measuring…'
    })
  })
})
