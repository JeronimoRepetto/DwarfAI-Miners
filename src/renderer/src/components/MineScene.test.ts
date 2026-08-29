// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defaultMine } from '../testing/factories'
import MineScene from './MineScene.vue'

describe('MineScene', () => {
  it('shows the vault chip with the mine tokensObserved in the header', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 25_000 }) } })
    expect(wrapper.get('.vault-ore').text()).toBe('2 ore')
    expect(wrapper.get('.vault-tokens').text()).toBe('25K')
  })

  it('renders no ore pile for a mine that has not mined any ore yet', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 0 }) } })
    expect(wrapper.find('.ore-pile').exists()).toBe(false)
  })

  it('grows the ore pile in discrete steps as ore increases', () => {
    // 5 ore -> orePileStep(5) = 2 nuggets.
    const small = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 50_000 }) } })
    expect(small.findAll('.ore-pile .nugget')).toHaveLength(2)

    // 150 ore -> orePileStep(150) = 5 (max) nuggets.
    const big = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 1_500_000 }) } })
    expect(big.findAll('.ore-pile .nugget')).toHaveLength(5)
  })
})
