// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { BUBBLE_TTL_MS } from '../lib/bubbles'
import { defaultDwarf, defaultMine } from '../testing/factories'
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

  it('pauses the bubble auto-hide while expanded and resumes it on close', async () => {
    vi.useFakeTimers()
    try {
      const mine = defaultMine({
        dwarfs: [defaultDwarf({ id: 'd1', lastMessage: 'A story long enough to need a hold.' })]
      })
      const wrapper = mount(MineScene, { props: { mine } })
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.speech-bubble').exists()).toBe(true)

      // Expanding holds the bubble on the board: far past the TTL it must remain.
      await wrapper.find('.bubble-hit').trigger('click')
      vi.advanceTimersByTime(BUBBLE_TTL_MS * 5)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.speech-bubble').exists()).toBe(true)

      // Closing releases it with a fresh full TTL, after which it hides normally.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await wrapper.vm.$nextTick()
      vi.advanceTimersByTime(BUBBLE_TTL_MS)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.speech-bubble').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
