// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
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
