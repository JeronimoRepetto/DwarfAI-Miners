// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defaultMaterials, defaultMine } from '../testing/factories'
import MineMound from './MineMound.vue'

/*
 * The map badge used to read oreCount(mine.tokensObserved): a flat pre-#22
 * gauge, always painted gold, driven by the LIVE token count rather than the
 * persisted ledger (see #48). Every test below drives the badge from
 * mine.materials instead, exactly as the mine interior's own piles do.
 */
describe('MineMound', () => {
  it("shows a badge with this mine's current-tier material count, read from the persisted ledger", () => {
    const wrapper = mount(MineMound, {
      props: {
        mine: defaultMine({ tier: 'bronze', materials: defaultMaterials({ bronze: 25_000 }) })
      }
    })
    expect(wrapper.get('.mound-ore').text()).toBe('2')
  })

  it('survives the crew leaving: the badge ignores tokensObserved, the live gauge that drops to zero once nobody is left to poll', () => {
    const wrapper = mount(MineMound, {
      props: {
        mine: defaultMine({
          tier: 'bronze',
          tokensObserved: 0,
          materials: defaultMaterials({ bronze: 25_000 })
        })
      }
    })
    expect(wrapper.get('.mound-ore').text()).toBe('2')
  })

  it('never lets a big live tokensObserved alone put a badge on the map when the ledger has nothing yet', () => {
    const wrapper = mount(MineMound, {
      props: {
        mine: defaultMine({
          tier: 'bronze',
          tokensObserved: 999_999,
          materials: defaultMaterials()
        })
      }
    })
    expect(wrapper.find('.mound-ore').exists()).toBe(false)
  })

  it('shows no ore badge for a mine with no materials mined yet, exactly as today', () => {
    const wrapper = mount(MineMound, { props: { mine: defaultMine() } })
    expect(wrapper.find('.mound-ore').exists()).toBe(false)
  })

  it('still shows the dwarf-count badge alongside the material badge', () => {
    const wrapper = mount(MineMound, {
      props: {
        mine: defaultMine({
          tier: 'bronze',
          materials: defaultMaterials({ bronze: 10_000 }),
          dwarfs: [
            {
              id: 'd1',
              provider: 'claude',
              role: 'worker',
              name: 'w',
              status: 'working',
              sessionId: 's1'
            }
          ]
        })
      }
    })
    expect(wrapper.get('.mound-count').text()).toBe('1')
    expect(wrapper.get('.mound-ore').text()).toBe('1')
  })

  it('names the mine material instead of "ore", with no gold-specific coding on a non-gold tier', () => {
    const wrapper = mount(MineMound, {
      props: {
        mine: defaultMine({ tier: 'copper', materials: defaultMaterials({ copper: 50_000 }) })
      }
    })
    const badge = wrapper.get('.mound-ore')
    expect(badge.text()).toBe('2')
    expect(badge.attributes('data-material')).toBe('copper')
    expect(wrapper.get('.mine-tooltip').text()).toContain('2 Copper mined')
    expect(wrapper.get('.mine-tooltip').text()).not.toContain('ore mined')
    expect(wrapper.find('[data-material="gold"]').exists()).toBe(false)
  })

  it('shows only the current tier material on the badge, and every material the ledger holds in the tooltip, for a mine that changed tier', () => {
    const wrapper = mount(MineMound, {
      props: {
        mine: defaultMine({
          tier: 'silver',
          // bronze (2 units) + copper (2 units) + silver (1 unit): a naive sum
          // would read "5" somewhere. It must not.
          materials: defaultMaterials({ bronze: 20_000, copper: 50_000, silver: 50_000 })
        })
      }
    })
    const badge = wrapper.get('.mound-ore')
    expect(badge.text()).toBe('1')
    expect(badge.attributes('data-material')).toBe('silver')
    const tooltip = wrapper.get('.mine-tooltip').text()
    expect(tooltip).toContain('2 Bronze mined')
    expect(tooltip).toContain('2 Copper mined')
    expect(tooltip).toContain('1 Silver mined')
    expect(tooltip).not.toContain('5')
  })

  it('lists a backfilled coal total in the tooltip even though coal has no tier and no live production', () => {
    const wrapper = mount(MineMound, {
      props: {
        mine: defaultMine({ tier: 'bronze', materials: defaultMaterials({ coal: 5_000 }) })
      }
    })
    expect(wrapper.get('.mine-tooltip').text()).toContain('2 Coal mined')
  })
})
