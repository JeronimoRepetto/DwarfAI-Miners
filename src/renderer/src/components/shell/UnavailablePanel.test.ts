// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import UnavailablePanel from './UnavailablePanel.vue'

describe('UnavailablePanel', () => {
  it('says the lab is being rebuilt, in the design’s own words', () => {
    const panel = mount(UnavailablePanel, { props: { feature: 'lab' } })
    expect(panel.text()).toContain("We're working to rebuild the lab.")
    expect(panel.text()).toContain('Please come back later.')
  })

  it('says the market is being rebuilt, in the design’s own words', () => {
    const panel = mount(UnavailablePanel, { props: { feature: 'market' } })
    expect(panel.text()).toContain("We're working to rebuild the market.")
    expect(panel.text()).toContain('Please come back later.')
  })

  it('draws each feature over its own painting', () => {
    const lab = mount(UnavailablePanel, { props: { feature: 'lab' } })
    const market = mount(UnavailablePanel, { props: { feature: 'market' } })
    const labArt = lab.find('.unavailable-art').attributes('src')
    const marketArt = market.find('.unavailable-art').attributes('src')
    expect(labArt).toBeTruthy()
    expect(marketArt).toBeTruthy()
    expect(labArt).not.toBe(marketArt)
  })

  it('is announced as a status rather than as an error', () => {
    // Nothing failed: the feature is intentionally not built yet, and the
    // design offers no action, retry or date.
    const panel = mount(UnavailablePanel, { props: { feature: 'lab' } })
    expect(panel.find('[role="status"]').exists()).toBe(true)
    expect(panel.find('[role="alert"]').exists()).toBe(false)
  })

  it('offers nothing to press, because the design offers nothing to do', () => {
    const panel = mount(UnavailablePanel, { props: { feature: 'market' } })
    expect(panel.findAll('button')).toHaveLength(0)
    expect(panel.findAll('a')).toHaveLength(0)
  })
})
