// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VaultChip from './VaultChip.vue'

describe('VaultChip', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the ore count and compact token total', () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 25_000 } })
    expect(wrapper.get('.vault-ore').text()).toBe('2 ore')
    expect(wrapper.get('.vault-tokens').text()).toBe('25K')
  })

  it('shows zero ore for a mine with no tokens observed yet', () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 0 } })
    expect(wrapper.get('.vault-ore').text()).toBe('0 ore')
    expect(wrapper.get('.vault-tokens').text()).toBe('0')
  })

  it('never sparkles on the initial render', () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 1_000 } })
    expect(wrapper.get('.vault-chip').classes()).not.toContain('is-sparkling')
  })

  it('sparkles briefly when tokens grow, then settles', async () => {
    vi.useFakeTimers()
    const wrapper = mount(VaultChip, { props: { tokensObserved: 1_000 } })
    await wrapper.setProps({ tokensObserved: 2_000 })
    await nextTick()
    expect(wrapper.get('.vault-chip').classes()).toContain('is-sparkling')

    vi.advanceTimersByTime(1_000)
    await nextTick()
    expect(wrapper.get('.vault-chip').classes()).not.toContain('is-sparkling')
  })

  it('does not sparkle when tokens stay the same or decrease', async () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 2_000 } })
    await wrapper.setProps({ tokensObserved: 2_000 })
    expect(wrapper.get('.vault-chip').classes()).not.toContain('is-sparkling')
    await wrapper.setProps({ tokensObserved: 1_500 })
    expect(wrapper.get('.vault-chip').classes()).not.toContain('is-sparkling')
  })

  it('renders inline (no floating position) when variant is inline', () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 1_000, variant: 'inline' } })
    expect(wrapper.get('.vault-chip').classes()).toContain('is-inline')
  })
})
