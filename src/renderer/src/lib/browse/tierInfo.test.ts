import { describe, expect, it } from 'vitest'
import { TIER_NOTE, grainRows, tierRanges } from './tierInfo'
import { MATERIAL_TOKENS_PER_UNIT, TIER_WEIGHT_THRESHOLDS_KB } from '../../types'

describe('tierRanges', () => {
  // AMENDED for #635 (PANEL-QUESTIONS 7, design lead ruling 2026-09-27): the ranges say their unit, KB.
  it('lists the five tiers in canonical order, each with its range in KB', () => {
    const floors = { copperKb: 100, silverKb: 500, goldKb: 2048, uraniumKb: 8192 }
    expect(tierRanges(floors)).toEqual([
      { tier: 'bronze', range: 'below 100 KB' },
      { tier: 'copper', range: '100 – 499 KB' },
      { tier: 'silver', range: '500 – 2,047 KB' },
      { tier: 'gold', range: '2,048 – 8,191 KB' },
      { tier: 'uranium', range: '8,192 KB and up' }
    ])
  })

  it('reads the app’s own thresholds by default, never the design’s sample', () => {
    const { copperKb, uraniumKb } = TIER_WEIGHT_THRESHOLDS_KB
    const ranges = tierRanges()
    expect(ranges[0]!.range).toBe('below ' + copperKb.toLocaleString('en-US') + ' KB')
    expect(ranges[4]!.range).toBe(uraniumKb.toLocaleString('en-US') + ' KB and up')
  })
})

describe('grainRows', () => {
  it('says what one unit of each material is worth, poorest first, from the grain table', () => {
    expect(grainRows()).toEqual([
      { material: 'coal', text: '1 = 2,500 tokens' },
      { material: 'bronze', text: '1 = 10K tokens' },
      { material: 'copper', text: '1 = 25K tokens' },
      { material: 'silver', text: '1 = 50K tokens' },
      { material: 'gold', text: '1 = 100K tokens' },
      { material: 'uranium', text: '1 = 250K tokens' }
    ])
    expect(MATERIAL_TOKENS_PER_UNIT.coal).toBe(2_500)
  })
})

describe('TIER_NOTE', () => {
  it('says the materials never convert, the invariant the explainer exists to state', () => {
    expect(TIER_NOTE).toBe('Each material is its own counter. They never convert into one another.')
  })
})
