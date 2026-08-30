// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDwarfKicking } from '../composables/useDwarfKicking'
import { useDwarfMessaging } from '../composables/useDwarfMessaging'
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

/**
 * The scene is the one place that already receives a fresh snapshot of every
 * dwarf on each poll, so it is what feeds reaction detection (issue #21). No
 * new IPC and no new main-process field: the panel simply watches the stream it
 * was already rendering.
 */
describe('MineScene reaction feed', () => {
  const WORKING = defaultDwarf({ id: 'claude:s1', status: 'working', lastMessage: 'a' })

  function stubApi(): void {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        kickDwarf: () => Promise.resolve({ delivered: true, via: 'claude-relay' }),
        sendDwarfText: () => Promise.resolve({ delivered: true, via: 'claude-relay' })
      }
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    stubApi()
    useDwarfKicking().clearAll()
    useDwarfMessaging().clearAll()
  })

  afterEach(() => {
    useDwarfKicking().clearAll()
    useDwarfMessaging().clearAll()
    vi.useRealTimers()
  })

  it('promotes a delivered kick when the next poll shows the session stopped', async () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs: [WORKING] }) } })
    const { kick, stateFor } = useDwarfKicking()

    await kick('claude:s1')
    expect(stateFor('claude:s1')?.phase).toBe('delivered')

    await wrapper.setProps({
      mine: defaultMine({ dwarfs: [{ ...WORKING, status: 'waiting' }] })
    })
    expect(stateFor('claude:s1')?.phase).toBe('reacted')
  })

  it('promotes a delivered message when the next poll shows new output', async () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs: [WORKING] }) } })
    const { send, stateFor } = useDwarfMessaging()

    await send('claude:s1', 'hi', true)
    expect(stateFor('claude:s1')?.phase).toBe('delivered')

    await wrapper.setProps({
      mine: defaultMine({ dwarfs: [{ ...WORKING, lastMessage: 'on it' }] })
    })
    expect(stateFor('claude:s1')?.phase).toBe('reacted')
  })

  it('leaves a delivery alone while nothing about the session changed', async () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs: [WORKING] }) } })
    const { kick, stateFor } = useDwarfKicking()

    await kick('claude:s1')
    await wrapper.setProps({ mine: defaultMine({ dwarfs: [{ ...WORKING }] }) })

    expect(stateFor('claude:s1')?.phase).toBe('delivered')
  })
})
