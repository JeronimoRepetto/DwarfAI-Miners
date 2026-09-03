// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAP_BG_SRC } from '../../lib/art'
import { MAP_TIME_REFRESH_MS } from '../../lib/map/mapTime'
import { MAP_TOOLTIP_DELAY_MS } from '../../lib/map/mapTooltip'
import { MAP_SPAWN_POINTS } from '../../lib/map/spawnPoints.generated'
import { defaultDwarf, defaultMaterials, defaultMine } from '../../testing/factories'
import MapView from './MapView.vue'

const MINES = [
  defaultMine({ id: 'C:/dev/alpha', name: 'alpha', tier: 'bronze' }),
  defaultMine({ id: 'C:/dev/beta', name: 'beta', tier: 'gold' }),
  defaultMine({ id: 'C:/dev/gamma', name: 'gamma', tier: 'uranium' })
]

/*
 * WHAT LEFT THIS FILE WITH THE 13-SITE MAP (#136).
 *
 * The hand-authored valley is gone, and four groups of tests went with their
 * subjects rather than being quietly dropped:
 *
 *  - "hands each mound the depth scale of its site" — MineSite.scale existed
 *    because the old painting was a valley in perspective and a far mound had
 *    to read smaller than a near one. The design's map is drawn from orbit and
 *    every mine is the same 10px hexagon, so there is no depth to paint.
 *  - "draws the authored trail overlay beneath the mounds" and "keeps the
 *    trails on an empty landscape" — MAP_TRAILS were hand-drawn paths joining
 *    thirteen named sites through VALLEY_HUB. The design's map has 74 spawn
 *    points, no hub, and no paths between them; a trail graph over them would
 *    be invention, not a port.
 *  - "marks the hovered mound hot and gently dims the rest" and "treats
 *    keyboard focus like hover for the mound linking" — the hover treatment the
 *    design specifies is a tooltip after 300ms, not a brightness link across
 *    the map. The tooltip tests below are what replaced them.
 *
 * Every other test here survived with `.mine-mound` read as `.mine-marker`.
 */

/** One mine's marker, found by the name in its label rather than by position. */
function markerFor(wrapper: ReturnType<typeof mount>, name: string) {
  const found = wrapper
    .findAll('.mine-marker')
    .find((marker) => marker.get('button').attributes('aria-label')?.includes(name))
  if (found === undefined) throw new Error(`no marker for ${name}`)
  return found
}
describe('MapView', () => {
  it('renders one marker per mine', () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    expect(wrapper.findAll('.mine-marker')).toHaveLength(3)
  })

  it('shows a calm empty landscape when no mines are active', () => {
    const wrapper = mount(MapView, { props: { mines: [] } })
    expect(wrapper.findAll('.mine-marker')).toHaveLength(0)
    expect(wrapper.find('.map-empty').text()).toContain('quiet')
  })

  it('emits open with the mine id when a marker is clicked', async () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    await markerFor(wrapper, 'beta').find('button').trigger('click')
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

  /*
    Unmeasured in jsdom — getBoundingClientRect answers zeros — and the
    projection's documented answer for a box nothing has measured is the
    authored coordinate unchanged. So a marker's style here IS its spawn point,
    which is what makes this assertion exact rather than approximate.
  */
  it('anchors every marker to one of the design’s 74 spawn points', () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    for (const marker of wrapper.findAll('.mine-marker')) {
      const style = marker.attributes('style') ?? ''
      const anchored = MAP_SPAWN_POINTS.some(
        (point) => style.includes(`left: ${point.x}%`) && style.includes(`top: ${point.y}%`)
      )
      expect(anchored, style).toBe(true)
    }
  })

  it('stands a mine on the spawn point the store remembers for it', () => {
    const placed = defaultMine({ id: 'C:/dev/placed', name: 'placed', mapSite: 42 })
    const point = MAP_SPAWN_POINTS.find((candidate) => candidate.id === 42)!
    const wrapper = mount(MapView, { props: { mines: [placed] } })
    const style = wrapper.get('.mine-marker').attributes('style') ?? ''
    expect(style).toContain(`left: ${point.x}%`)
    expect(style).toContain(`top: ${point.y}%`)
  })

  /*
    A mine main has not placed — a simulated valley, or the poll before the
    store's first write — still has to be drawn somewhere, and somewhere
    STABLE: the fallback is derived from the mine's own id, so it does not move
    between polls. Nothing about it is persisted.
  */
  it('places a mine the store has not placed, deterministically and without persisting it', () => {
    const first = mount(MapView, { props: { mines: MINES } })
    const second = mount(MapView, { props: { mines: [...MINES].reverse() } })
    for (const name of ['alpha', 'beta', 'gamma']) {
      expect(markerFor(first, name).attributes('style')).toBe(
        markerFor(second, name).attributes('style')
      )
    }
  })

  /*
    Markers stack among themselves by spawn-point depth, which runs to 99 —
    well past the vault chip's own z-index of 5. Keeping them inside one
    positioned layer bounds that: the layer takes its place in the map's
    stacking order once, so a marker can never climb over the totals the design
    puts in the upper-right corner. Reachable in practice, not theory: a wide
    panel crops the painting vertically and the clamp then holds the topmost
    markers against the top edge, right under the chip.
  */
  it('keeps every marker in one layer beneath the vault chip', () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    const layer = wrapper.get('.map-markers')
    expect(layer.findAll('.mine-marker')).toHaveLength(MINES.length)
    expect(wrapper.findAll('.map-markers > .mine-marker')).toHaveLength(MINES.length)
  })

  it('never stands two mines on the same spawn point', () => {
    const wrapper = mount(MapView, { props: { mines: MINES } })
    const styles = wrapper.findAll('.mine-marker').map((marker) => marker.attributes('style'))
    expect(new Set(styles).size).toBe(styles.length)
  })

  it('keeps a marker where it was across a refresh', () => {
    const first = mount(MapView, { props: { mines: MINES } })
    const second = mount(MapView, { props: { mines: [...MINES].reverse() } })
    for (const name of ['alpha', 'beta', 'gamma']) {
      expect(markerFor(first, name).attributes('style')).toBe(
        markerFor(second, name).attributes('style')
      )
    }
  })
})

/**
 * The hover tooltip (#136): `300ms` of continuous hover, and the design's three
 * lines of copy.
 */
describe('MapView mine tooltip', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const CREWED = defaultMine({
    id: 'C:/dev/beta',
    name: 'beta',
    tier: 'uranium',
    mapSite: 20,
    dwarfs: [defaultDwarf(), defaultDwarf()]
  })

  it('says nothing until the pointer has rested for the design’s 300ms', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapView, { props: { mines: [CREWED] } })

    await wrapper.get('.mine-marker').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(MAP_TOOLTIP_DELAY_MS - 1)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.mine-tooltip').exists()).toBe(false)
  })

  it('shows the tooltip once the pointer has rested that long', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapView, { props: { mines: [CREWED] } })

    await wrapper.get('.mine-marker').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(MAP_TOOLTIP_DELAY_MS)
    await wrapper.vm.$nextTick()

    const tooltip = wrapper.get('.mine-tooltip')
    expect(tooltip.get('.tooltip-tier').text()).toBe('Uranium - Mine')
    expect(tooltip.get('.tooltip-name').text()).toBe('beta')
    expect(tooltip.get('.tooltip-agents').text()).toBe('Agents working: 2')
  })

  /*
    "Continuous" is the whole of the requirement: a pointer that crosses the
    marker on its way somewhere else must leave nothing behind it.
  */
  it('shows nothing for a pointer that only passes over the marker', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapView, { props: { mines: [CREWED] } })

    await wrapper.get('.mine-marker').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(MAP_TOOLTIP_DELAY_MS - 50)
    await wrapper.get('.mine-marker').trigger('mouseleave')
    await vi.advanceTimersByTimeAsync(MAP_TOOLTIP_DELAY_MS)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.mine-tooltip').exists()).toBe(false)
  })

  it('hides the tooltip when the pointer leaves the marker', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapView, { props: { mines: [CREWED] } })

    await wrapper.get('.mine-marker').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(MAP_TOOLTIP_DELAY_MS)
    await wrapper.get('.mine-marker').trigger('mouseleave')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.mine-tooltip').exists()).toBe(false)
  })

  /*
    Keyboard access is listed as Unspecified by the design, so this is a
    decision: focus shows the tooltip AT ONCE. The 300ms exists to stop a
    pointer sweeping the map from flashing tooltips, and a keyboard user
    tabbing onto a marker has already made that choice deliberately.
  */
  it('shows the tooltip immediately for a marker reached by keyboard', async () => {
    const wrapper = mount(MapView, { props: { mines: [CREWED] } })

    await wrapper.get('.mine-marker').trigger('focusin')

    expect(wrapper.get('.mine-tooltip').get('.tooltip-name').text()).toBe('beta')
  })

  it('shows one tooltip at a time, whatever the pointer does', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapView, { props: { mines: MINES } })

    await markerFor(wrapper, 'alpha').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(MAP_TOOLTIP_DELAY_MS)
    await markerFor(wrapper, 'gamma').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(MAP_TOOLTIP_DELAY_MS)
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.mine-tooltip')).toHaveLength(1)
    expect(wrapper.get('.mine-tooltip').get('.tooltip-name').text()).toBe('gamma')
  })

  it('drops a pending tooltip when the map is torn down', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapView, { props: { mines: [CREWED] } })

    await wrapper.get('.mine-marker').trigger('mouseenter')
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(MAP_TOOLTIP_DELAY_MS * 2)

    expect(vi.getTimerCount()).toBe(0)
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
