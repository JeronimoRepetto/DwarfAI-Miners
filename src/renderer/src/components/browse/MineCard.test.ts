// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defaultProject } from '../../testing/factories'
import MineCard from './MineCard.vue'

describe('MineCard naming', () => {
  it('names the measured tier beside the project', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ knownTier: 'copper', name: 'Lalo-Test' }) }
    })
    expect(wrapper.get('.card-tier').text()).toBe('Cropper mine -')
    expect(wrapper.get('.card-name').text()).toBe('Lalo-Test')
  })

  it('claims no tier for a project nobody has walked yet', () => {
    // Absence over invention (#41): an unmeasured project is shown as itself,
    // not as the bronze the map would provisionally draw it with.
    const wrapper = mount(MineCard, { props: { project: defaultProject({ name: 'fresh' }) } })
    expect(wrapper.find('.card-tier').exists()).toBe(false)
    expect(wrapper.get('.card-name').text()).toBe('fresh')
  })

  it('paints the entrance of the measured tier', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ knownTier: 'gold' }) }
    })
    expect(wrapper.get('.card-art').attributes('src')).toBeTruthy()
  })

  it('paints no entrance for an unmeasured project', () => {
    const wrapper = mount(MineCard, { props: { project: defaultProject() } })
    expect(wrapper.find('.card-art').exists()).toBe(false)
  })
})

describe('MineCard crew', () => {
  it('states the crew working the mine right now', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ live: true }), activeAgents: 3 }
    })
    expect(wrapper.get('.card-agents').text()).toBe('Active agents: 3')
  })

  it('states an empty crew, which the board can back', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ live: true }), activeAgents: 0 }
    })
    expect(wrapper.get('.card-agents').text()).toBe('Active agents: 0')
  })

  it('says nothing about the crew of a project nobody is working', () => {
    const wrapper = mount(MineCard, { props: { project: defaultProject({ live: false }) } })
    expect(wrapper.find('.card-agents').exists()).toBe(false)
  })
})

describe('MineCard action', () => {
  it('opens the mine of a live project', async () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ id: 'C:/dev/alpha', live: true }), activeAgents: 1 }
    })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['C:/dev/alpha']])
  })

  it('offers no click affordance for a project with no mine to enter', () => {
    // The empty-mine interior is not built yet; a button that opened nothing
    // would be a dead affordance pretending to work.
    const wrapper = mount(MineCard, { props: { project: defaultProject({ live: false }) } })
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
