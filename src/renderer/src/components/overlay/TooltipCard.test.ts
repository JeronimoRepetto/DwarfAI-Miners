// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TooltipCard from './TooltipCard.vue'

/*
 * The tooltip card the map's and the dwarf's tooltips share (#635), molecules/tooltip. It replaces
 * the map's own 170x60 `.mine-tooltip` (MapView.vue); what the map's card says is
 * lib/map/mapPage.test.ts's ("mineTip"), when and where it shows MapPage.test.ts's and
 * lib/overlay/tipCard.test.ts's.
 */
describe('TooltipCard', () => {
  const rows = [
    { label: 'Dwarfs working', value: '3' },
    { label: 'Needs you', value: '1' }
  ]

  it('is a raised card named as a tooltip, which no pointer can land on', () => {
    const wrapper = mount(TooltipCard, { props: { title: 'DwarfAI-Miners', rows } })
    const card = wrapper.get('[role="tooltip"]')
    expect(card.classes()).toEqual(expect.arrayContaining(['dm-tip', 'm-mat', 'm-raised']))
  })

  it('titles the card with the tier chip, then the name', () => {
    const wrapper = mount(TooltipCard, { props: { tier: 'silver', title: 'DwarfAI-Miners', rows } })
    const title = wrapper.get('.dm-tip__title')
    expect(title.get('.dm-tier').attributes('data-tier')).toBe('silver')
    expect(title.text()).toBe('SilverDwarfAI-Miners')
  })

  it('draws each fact as a row: its label, then its value in bold ink', () => {
    const wrapper = mount(TooltipCard, { props: { title: 'x', rows } })
    const drawn = wrapper.findAll('.dm-tip__row')
    expect(drawn.map((row) => [row.text(), row.get('b').text()])).toEqual([
      ['Dwarfs working3', '3'],
      ['Needs you1', '1']
    ])
  })

  it('has no title line without a title, for a card that brings its own body', () => {
    const wrapper = mount(TooltipCard, { slots: { default: '<p class="own">body</p>' } })
    expect(wrapper.find('.dm-tip__title').exists()).toBe(false)
    expect(wrapper.get('.own').text()).toBe('body')
  })
})
