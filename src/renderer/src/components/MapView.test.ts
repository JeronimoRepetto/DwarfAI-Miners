// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { MAP_TRAILS, MINE_SITES } from '../lib/mapSites'
import { defaultMine } from '../testing/factories'
import MapView from './MapView.vue'

const MINES = [
  defaultMine({ id: 'C:/dev/alpha', name: 'alpha', tier: 'bronze' }),
  defaultMine({ id: 'C:/dev/beta', name: 'beta', tier: 'gold' }),
  defaultMine({ id: 'C:/dev/gamma', name: 'gamma', tier: 'uranium' })
]

describe('MapView', () => {
  it('renders one mound per mine', () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    expect(wrapper.findAll('.mine-mound')).toHaveLength(3)
  })

  it('shows a calm empty landscape when no mines are active', () => {
    const wrapper = mount(MapView, { props: { mines: [] } })
    expect(wrapper.findAll('.mine-mound')).toHaveLength(0)
    expect(wrapper.find('.map-empty').text()).toContain('quiet')
  })

  it('emits open with the mine id when a mound is clicked', async () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    const beta = wrapper
      .findAll('.mine-mound')
      .find((mound) => mound.text().includes('beta')) as NonNullable<
      ReturnType<typeof wrapper.find>
    >
    await beta.find('button').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['C:/dev/beta']])
  })

  it('shows the vault chip with the given token total', () => {
    const wrapper = mount(MapView, { props: { mines: MINES, tokensObserved: 25_000 } })
    expect(wrapper.get('.vault-tokens').text()).toBe('25K')
    expect(wrapper.get('.vault-ore').text()).toBe('2 ore')
  })

  it('defaults the vault chip to zero when no total is given', () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    expect(wrapper.get('.vault-ore').text()).toBe('0 ore')
  })

  it('anchors every mound to an authored site of the painting', () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    for (const mound of wrapper.findAll('.mine-mound')) {
      const style = mound.attributes('style') ?? ''
      const anchored = MINE_SITES.some(
        (site) => style.includes(`left: ${site.x}%`) && style.includes(`top: ${site.y}%`)
      )
      expect(anchored, style).toBe(true)
    }
  })

  it('hands each mound the depth scale of its site, so the valley keeps perspective', () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    for (const mound of wrapper.findAll('.mine-mound')) {
      const style = mound.attributes('style') ?? ''
      const site = MINE_SITES.find(
        (candidate) =>
          style.includes(`left: ${candidate.x}%`) && style.includes(`top: ${candidate.y}%`)
      )
      expect(site, style).toBeDefined()
      const element = mound.element as HTMLElement
      expect(element.style.getPropertyValue('--site-scale'), site?.name).toBe(`${site?.scale}`)
    }
  })

  it('draws the authored trail overlay beneath the mounds', () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    expect(wrapper.findAll('.map-trail')).toHaveLength(MAP_TRAILS.length)
    const html = wrapper.html()
    expect(html.indexOf('map-trails')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('map-trails')).toBeLessThan(html.indexOf('mine-mound'))
  })

  it('keeps the trails on an empty landscape — they belong to the painting', () => {
    const wrapper = mount(MapView, { props: { mines: [] } })
    expect(wrapper.findAll('.map-trail')).toHaveLength(MAP_TRAILS.length)
  })

  it('marks the hovered mound hot and gently dims the rest', async () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    const beta = wrapper
      .findAll('.mine-mound')
      .find((mound) => mound.text().includes('beta')) as NonNullable<
      ReturnType<typeof wrapper.find>
    >
    await beta.trigger('mouseenter')
    expect(beta.classes()).toContain('is-hot')
    for (const mound of wrapper.findAll('.mine-mound')) {
      if (!mound.text().includes('beta')) expect(mound.classes()).toContain('is-dim')
    }
    await beta.trigger('mouseleave')
    for (const mound of wrapper.findAll('.mine-mound')) {
      expect(mound.classes()).not.toContain('is-hot')
      expect(mound.classes()).not.toContain('is-dim')
    }
  })

  it('treats keyboard focus like hover for the mound linking', async () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    const alpha = wrapper
      .findAll('.mine-mound')
      .find((mound) => mound.text().includes('alpha')) as NonNullable<
      ReturnType<typeof wrapper.find>
    >
    await alpha.trigger('focusin')
    expect(alpha.classes()).toContain('is-hot')
    for (const mound of wrapper.findAll('.mine-mound')) {
      if (!mound.text().includes('alpha')) expect(mound.classes()).toContain('is-dim')
    }
    await alpha.trigger('focusout')
    for (const mound of wrapper.findAll('.mine-mound')) {
      expect(mound.classes()).not.toContain('is-hot')
      expect(mound.classes()).not.toContain('is-dim')
    }
  })

  it('keeps a mound anchored to the same slot across refreshes', () => {
    const first = mount(MapView, { props: { mines: MINES } })
    const second = mount(MapView, { props: { mines: [...MINES].reverse() } })
    const styleOf = (wrapper: ReturnType<typeof mount>, name: string): string | undefined =>
      wrapper
        .findAll('.mine-mound')
        .find((mound) => mound.text().includes(name))
        ?.attributes('style')
    for (const name of ['alpha', 'beta', 'gamma']) {
      expect(styleOf(first, name)).toBe(styleOf(second, name))
    }
  })
})
