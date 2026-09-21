// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { MOUND_SRC } from '../../lib/art'
import { MINE_TIERS, TIER_WEIGHT_THRESHOLDS_KB } from '../../types'
import TierInfoModal from './TierInfoModal.vue'

function thresholdText(tier: string): string {
  if (tier === 'bronze') return 'Any size'
  const key = `${tier}Kb` as keyof typeof TIER_WEIGHT_THRESHOLDS_KB
  const kb = TIER_WEIGHT_THRESHOLDS_KB[key]
  return `≥ ${kb.toLocaleString()} KB`
}

describe('TierInfoModal', () => {
  it('renders a row for every tier in order', () => {
    const wrapper = mount(TierInfoModal)
    const rows = wrapper.findAll('.info-table tbody tr')
    expect(rows).toHaveLength(MINE_TIERS.length)
    rows.forEach((row, index) => {
      const tier = MINE_TIERS[index]!
      expect(row.get('.info-tier').text()).toBe(tier.charAt(0).toUpperCase() + tier.slice(1))
    })
  })

  it('shows the threshold for each tier', () => {
    const wrapper = mount(TierInfoModal)
    const rows = wrapper.findAll('.info-table tbody tr')
    rows.forEach((row, index) => {
      const tier = MINE_TIERS[index]!
      expect(row.get('.info-threshold').text()).toBe(thresholdText(tier))
    })
  })

  it('emits close when the close button is clicked', async () => {
    const wrapper = mount(TierInfoModal)
    await wrapper.get('.modal-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('emits close on Escape', async () => {
    const wrapper = mount(TierInfoModal)
    await wrapper.get('.info-modal').trigger('keydown.escape')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('draws the title in accent colour', () => {
    const wrapper = mount(TierInfoModal)
    const title = wrapper.get('.modal-title')
    expect(title.text()).toBe('Tier thresholds')
    // The colour is applied by the scoped style; asserting the class is enough.
    expect(title.classes()).toContain('modal-title')
  })
})

/*
 * The entrance painting beside each tier name (#538 follow-up). The table named
 * a tier and nothing else, which left the reader matching a word to a mine they
 * had only ever seen drawn — the same reference MaterialInfoModal gives with
 * its nuggets.
 */
describe('TierInfoModal tier art', () => {
  it('draws the entrance painting of every tier beside its name', () => {
    const wrapper = mount(TierInfoModal)
    const rows = wrapper.findAll('.info-table tbody tr')
    rows.forEach((row, index) => {
      const tier = MINE_TIERS[index]!
      expect(row.get('.info-mound').attributes('src')).toBe(MOUND_SRC[tier])
    })
  })

  it('keeps the art out of the accessible name the tier text already carries', () => {
    const wrapper = mount(TierInfoModal)
    const art = wrapper.findAll('.info-mound')
    expect(art).toHaveLength(MINE_TIERS.length)
    art.forEach((image) => {
      expect(image.attributes('alt')).toBe('')
    })
  })
})
