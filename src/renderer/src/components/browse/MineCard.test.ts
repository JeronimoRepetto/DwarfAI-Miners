// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defaultMaterials, defaultProject } from '../../testing/factories'
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

/*
 * The mock's resource row (#135, #139). It is drawn through the vault's own
 * `vaultRows`/`formatUnits`/NUGGET_SRC, which is the point of these tests:
 * a card must not grow a second way to count or draw a material, so what is
 * pinned here is the rules that module already enforces showing up on a card.
 */
describe('MineCard resources', () => {
  it('draws one pill per material the vault holds, poorest first', () => {
    const wrapper = mount(MineCard, {
      props: {
        project: defaultProject({
          materials: defaultMaterials({ coal: 220_500_000, silver: 60_000_000 })
        })
      }
    })
    expect(
      wrapper.findAll('.card-resource').map((pill) => pill.attributes('data-material'))
    ).toEqual(['coal', 'silver'])
  })

  it('compacts the count the same way the vault chip does', () => {
    // 220_500_000 coal at 2_500 tokens a nugget is 88_200 nuggets — "88.2K".
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ materials: defaultMaterials({ coal: 220_500_000 }) }) }
    })
    expect(wrapper.get('.card-resource .resource-count').text()).toBe('88.2K')
  })

  it('carries the painted nugget of that material', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ materials: defaultMaterials({ gold: 500_000 }) }) }
    })
    expect(wrapper.get('.card-resource img').attributes('src')).toBeTruthy()
  })

  it('draws no pill for a material short of one whole nugget', () => {
    // The vault's rule (#22): a labelled row with nothing in it claims a pile
    // that is not there. Half a nugget of gold is not a pile.
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ materials: defaultMaterials({ gold: 50_000 }) }) }
    })
    expect(wrapper.findAll('.card-resource')).toHaveLength(0)
  })

  it('draws no resource row at all for a project the ledger has no row for', () => {
    // Absent materials is "never mined", not "mined zero" (#139) — and a row
    // of zeros would be the invention this card refuses everywhere else.
    const wrapper = mount(MineCard, { props: { project: defaultProject() } })
    expect(wrapper.find('.card-resources').exists()).toBe(false)
  })

  it('draws no resource row when the ledger row is empty', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ materials: defaultMaterials() }) }
    })
    expect(wrapper.find('.card-resources').exists()).toBe(false)
  })

  it('names the ore in words for anyone who cannot see the painting', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ materials: defaultMaterials({ coal: 220_500_000 }) }) }
    })
    expect(wrapper.get('.card-resource').attributes('title')).toContain('Coal')
  })
})

describe('MineCard crew', () => {
  /*
   * AMENDED for #135: the three crew tests below asserted 'Active agents'.
   * The mock capitalizes it — `Active Agents: 0` — and the maintainer ruled
   * the mock is the visual truth for this panel, so the copy follows the mock
   * and disagrees with the lowercase 'Active agents' in components.md and
   * screens/browse.md. Nothing else about these tests moved.
   */
  it('states the crew working the mine right now', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ live: true }), activeAgents: 3 }
    })
    expect(wrapper.get('.card-agents').text()).toBe('Active Agents: 3')
  })

  it('states an empty crew, which the board can back', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ live: true }), activeAgents: 0 }
    })
    expect(wrapper.get('.card-agents').text()).toBe('Active Agents: 0')
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
