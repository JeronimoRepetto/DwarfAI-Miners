// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import VaultStrip from './VaultStrip.vue'

const ORE = [
  { material: 'coal' as const, units: 6277 },
  { material: 'bronze' as const, units: 1158 },
  { material: 'uranium' as const, units: 2 }
]

describe('VaultStrip', () => {
  it('is a group named "Ore", one capsule per material, each naming itself in full', () => {
    const wrapper = mount(VaultStrip, { props: { ore: ORE } })
    const group = wrapper.get('[role="group"]')
    expect(group.attributes('aria-label')).toBe('Ore')
    expect(wrapper.findAll('.dm-ore').map((o) => o.attributes('aria-label'))).toEqual([
      'Coal: 6,277',
      'Bronze: 1,158',
      'Uranium: 2'
    ])
  })

  it('takes its label as its name, and shows it first when it has one', () => {
    const wrapper = mount(VaultStrip, { props: { ore: ORE, label: 'Ore', plate: true } })
    expect(wrapper.get('.dm-vault__label').text()).toBe('Ore')
    expect(wrapper.get('[role="group"]').classes()).toEqual(
      expect.arrayContaining(['dm-vault--plate', 'm-mat', 'm-wood'])
    )
  })

  it('keeps only the richest materials by grain when capped', () => {
    const wrapper = mount(VaultStrip, { props: { ore: ORE, max: 2 } })
    expect(wrapper.findAll('.dm-ore').map((o) => o.attributes('aria-label'))).toEqual([
      'Bronze: 1,158',
      'Uranium: 2'
    ])
  })

  it('reads "No ore yet" with every counter at zero, and draws no capsule', () => {
    const wrapper = mount(VaultStrip, { props: { ore: [], label: 'Ore', plate: true } })
    expect(wrapper.find('.dm-ore').exists()).toBe(false)
    expect(wrapper.get('.dm-vault__empty').text()).toBe('No ore yet')
  })

  it('draws the vault size of capsule when asked', () => {
    const wrapper = mount(VaultStrip, { props: { ore: ORE, size: 'lg' } })
    expect(wrapper.findAll('.dm-ore--lg')).toHaveLength(3)
  })
})
