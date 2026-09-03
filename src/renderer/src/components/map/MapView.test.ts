// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAP_BG_SRC } from '../../lib/art'
import { MAP_TRAILS, MINE_SITES } from '../../lib/map/mapSites'
import { MAP_TIME_REFRESH_MS } from '../../lib/map/mapTime'
import { defaultMaterials, defaultMine } from '../../testing/factories'
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

  /*
   * The chip's single `N ore` figure — every token divided by one flat rate —
   * is gone with #22: it only meant anything if every material converted into
   * every other, which is exactly what the vault refuses. What replaced it is
   * one entry per material, so these two now check the token gauge and the
   * empty state instead.
   */
  it('shows the vault chip with the given token total', () => {
    const wrapper = mount(MapView, { props: { mines: MINES, tokensObserved: 25_000 } })
    expect(wrapper.get('.vault-tokens').text()).toBe('25K')
  })

  it('defaults the vault chip to zero when no total is given', () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    expect(wrapper.get('.vault-tokens').text()).toBe('0')
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

/*
 * The four paintings, chosen by the user's own clock (#136). The design gives
 * the table; what these check is that the panel actually asks the clock, keeps
 * asking, and stops asking when it is torn down.
 */
describe('MapView time-of-day artwork', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Mount with the wall clock frozen at a local hour of the day. */
  function mountAt(hours: number): ReturnType<typeof mount> {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 3, hours, 0, 0, 0))
    return mount(MapView, { props: { mines: MINES } })
  }

  it.each([
    [9, 'morning'],
    [12, 'day'],
    [17, 'sunset'],
    [23, 'night'],
    [4, 'night']
  ] as const)('draws the %i:00 painting, which is %s', (hours, variant) => {
    const wrapper = mountAt(hours)
    expect(wrapper.get('.map-art').attributes('src')).toBe(MAP_BG_SRC[variant])
  })

  it('changes the painting when the clock crosses a boundary while the map is open', async () => {
    const wrapper = mountAt(19)
    expect(wrapper.get('.map-art').attributes('src')).toBe(MAP_BG_SRC.sunset)

    vi.setSystemTime(new Date(2026, 8, 3, 20, 0, 0, 0))
    await vi.advanceTimersByTimeAsync(MAP_TIME_REFRESH_MS)
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.map-art').attributes('src')).toBe(MAP_BG_SRC.night)
  })

  /*
    An interval left running after the view is gone is the classic leak in a
    panel that switches between five screens all day: it is invisible, it never
    fails a test that does not look for it, and it costs a wake-up a minute for
    every map the user ever opened.
  */
  it('stops watching the clock once the map is unmounted', async () => {
    const wrapper = mountAt(19)
    wrapper.unmount()
    vi.setSystemTime(new Date(2026, 8, 3, 20, 0, 0, 0))
    await vi.advanceTimersByTimeAsync(MAP_TIME_REFRESH_MS * 3)
    expect(vi.getTimerCount()).toBe(0)
  })
})

/*
 * The map chip shows the WHOLE vault (see #22), which main sums over the entire
 * persisted ledger rather than over the mines on screen. That is deliberate and
 * it is the only reason coal is ever visible: the historical backfill credits
 * projects whose sessions all ended long ago and which have no mound today.
 */
describe('MapView global vault', () => {
  it('breaks the vault down by material, including ore no mine on screen produces', () => {
    const wrapper = mount(MapView, {
      props: {
        mines: MINES,
        tokensObserved: 25_000,
        materials: defaultMaterials({ coal: 500_000, bronze: 25_000 })
      }
    })
    const entries = wrapper.findAll('.vault-material')
    expect(entries.map((entry) => entry.attributes('data-material'))).toEqual(['coal', 'bronze'])
    expect(entries.map((entry) => entry.get('.vault-units').text())).toEqual(['200', '2'])
  })

  it('shows an empty vault rather than nothing when no breakdown has arrived', () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    expect(wrapper.get('.vault-empty').text()).toBe('no ore yet')
  })
})
