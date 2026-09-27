// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { MAP_TIME_REFRESH_MS } from '../lib/map/mapTime'
import { useMapTime } from './useMapTime'

/*
 * The painting the valley wears, read from the clock (#136). It moved here from MapView.vue's
 * "time-of-day artwork" tests with the redesign (#635): the Map page draws whichever painting its
 * host hands it, and the host owns the clock.
 */
const Host = defineComponent({
  setup() {
    const variant = useMapTime()
    return () => h('span', variant.value)
  }
})

describe('useMapTime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Mount with the wall clock frozen at a local hour of the day. */
  function mountAt(hours: number): ReturnType<typeof mount> {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 3, hours, 0, 0, 0))
    return mount(Host)
  }

  it.each([
    [9, 'morning'],
    [12, 'day'],
    [17, 'sunset'],
    [23, 'night'],
    [4, 'night']
  ] as const)('reads the %i:00 painting as %s', (hours, variant) => {
    expect(mountAt(hours).text()).toBe(variant)
  })

  it('changes the painting when the clock crosses a boundary while the map is open', async () => {
    const wrapper = mountAt(19)
    expect(wrapper.text()).toBe('sunset')

    vi.setSystemTime(new Date(2026, 8, 3, 20, 0, 0, 0))
    await vi.advanceTimersByTimeAsync(MAP_TIME_REFRESH_MS)

    expect(wrapper.text()).toBe('night')
  })

  // An interval left running after its host is gone is a wake-up a minute nobody ever sees.
  it('stops watching the clock once its host is unmounted', async () => {
    const wrapper = mountAt(19)
    wrapper.unmount()
    vi.setSystemTime(new Date(2026, 8, 3, 20, 0, 0, 0))
    await vi.advanceTimersByTimeAsync(MAP_TIME_REFRESH_MS * 3)
    expect(vi.getTimerCount()).toBe(0)
  })
})
