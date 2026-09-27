// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TierInfo from './TierInfo.vue'

describe('TierInfo', () => {
  it('lists the tiers in canonical order, each with its mound, its chip and its range', () => {
    const info = mount(TierInfo, {
      props: { thresholds: { copperKb: 100, silverKb: 500, goldKb: 2048, uraniumKb: 8192 } }
    })
    const rows = info.findAll('.dm-tinfo__row')
    expect(rows.map((r) => r.get('.dm-tier').text())).toEqual([
      'Bronze',
      'Copper',
      'Silver',
      'Gold',
      'Uranium'
    ])
    // AMENDED for #635 (PANEL-QUESTIONS 7): the range says its unit, KB.
    expect(rows[1]!.get('.dm-tinfo__range').text()).toBe('100 – 499 KB')
    // The mound is art: the chip's word already names the tier.
    expect(rows.every((r) => r.get('img').attributes('alt') === '')).toBe(true)
  })

  it('says what one unit of each material is worth, one capsule each, poorest first', () => {
    const grains = mount(TierInfo).findAll('.dm-tinfo__grain')
    expect(grains).toHaveLength(6)
    expect(grains[0]!.get('.dm-ore').attributes('aria-label')).toBe('Coal: 1')
    expect(grains[0]!.text()).toContain('1 = 2,500 tokens')
    expect(grains[5]!.get('.dm-ore').attributes('aria-label')).toBe('Uranium: 1')
  })

  it('ends on the rule that materials never convert into one another', () => {
    expect(mount(TierInfo).get('.dm-tinfo__note').text()).toBe(
      'Each material is its own counter. They never convert into one another.'
    )
  })
})
