// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defaultMine } from '../testing/factories'
import MineMound from './MineMound.vue'

describe('MineMound', () => {
  it('shows an ore badge with the mine ore count when it has mined some', () => {
    const wrapper = mount(MineMound, { props: { mine: defaultMine({ tokensObserved: 25_000 }) } })
    expect(wrapper.get('.mound-ore').text()).toBe('2')
  })

  it('shows no ore badge for a mine with no ore yet', () => {
    const wrapper = mount(MineMound, { props: { mine: defaultMine({ tokensObserved: 0 }) } })
    expect(wrapper.find('.mound-ore').exists()).toBe(false)
  })

  it('still shows the dwarf-count badge alongside the ore badge', () => {
    const wrapper = mount(MineMound, {
      props: {
        mine: defaultMine({
          tokensObserved: 15_000,
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
})
