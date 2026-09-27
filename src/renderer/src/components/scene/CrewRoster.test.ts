// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import CrewRoster from './CrewRoster.vue'

const crew = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    defaultDwarf({ id: 'r' + i, name: 'dwarfai-5' + (3 + i), status: 'working' })
  )

afterEach(() => {
  document.body.innerHTML = ''
})

/*
 * The crew roster (#635, components.md, Crew roster; screens/mine.md, W3·4): a group named "Crew",
 * one portrait per dwarf with its state, each a press that does what clicking the sprite does.
 * Five fit; from six, four and a +N menu of the rest. It never scrolls.
 */
describe('CrewRoster', () => {
  it('is a group named "Crew" of one portrait button per dwarf, named "<name>, <state>"', () => {
    const wrapper = mount(CrewRoster, {
      props: {
        dwarfs: [
          defaultDwarf({ id: 'r0', name: 'dwarfai-53', status: 'working' }),
          defaultDwarf({
            id: 'r1',
            name: 'dwarfai-54',
            status: 'waiting',
            waitingReason: 'approval'
          }),
          defaultDwarf({ id: 'r2', name: 'dwarfai-55', role: 'foreman', status: 'waiting' })
        ]
      }
    })
    const row = wrapper.find('.dm-roster')
    expect(row.attributes('role')).toBe('group')
    expect(row.attributes('aria-label')).toBe('Crew')
    const portraits = wrapper.findAll('button.dm-portrait')
    expect(portraits.map((p) => p.attributes('aria-label'))).toEqual([
      'dwarfai-53, working',
      'dwarfai-54, needs you',
      'dwarfai-55, asleep'
    ])
    expect(portraits.map((p) => p.attributes('data-status'))).toEqual([
      'working',
      'asking',
      'asleep'
    ])
    expect(portraits.map((p) => p.attributes('data-dwarf'))).toEqual(['r0', 'r1', 'r2'])
  })

  it('marks the selected dwarf pressed, and no other', () => {
    const wrapper = mount(CrewRoster, { props: { dwarfs: crew(4), selectedId: 'r0' } })
    expect(wrapper.findAll('button.dm-portrait').map((p) => p.attributes('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
      'false'
    ])
  })

  it('reports a portrait press as the dwarf it names', async () => {
    const dwarfs = crew(3)
    const wrapper = mount(CrewRoster, { props: { dwarfs } })
    await wrapper.findAll('button.dm-portrait')[1]!.trigger('click')
    expect(wrapper.emitted('pick')).toEqual([[dwarfs[1]]])
  })

  it('shows five portraits and no +N when five fit', () => {
    const wrapper = mount(CrewRoster, { props: { dwarfs: crew(5) } })
    expect(wrapper.findAll('button.dm-portrait')).toHaveLength(5)
    expect(wrapper.find('.dm-roster__more').exists()).toBe(false)
  })

  it('shows four and a +N menu button for the rest from six on', () => {
    const wrapper = mount(CrewRoster, { props: { dwarfs: crew(8) } })
    expect(wrapper.findAll('button.dm-portrait')).toHaveLength(4)
    const more = wrapper.find('button.dm-roster__more')
    expect(more.text()).toBe('+4')
    expect(more.attributes('aria-label')).toBe('4 more dwarfs')
    expect(more.attributes('aria-haspopup')).toBe('menu')
    expect(more.attributes('aria-expanded')).toBe('false')
  })

  it('opens the rest as a menu, and picking one does what a portrait press does', async () => {
    const dwarfs = crew(7)
    const wrapper = mount(CrewRoster, { props: { dwarfs }, attachTo: document.body })
    await wrapper.find('button.dm-roster__more').trigger('click')
    await wrapper.vm.$nextTick()
    const items = [...document.body.querySelectorAll('.dm-menu__item')]
    expect(items.map((item) => item.textContent)).toEqual([
      'dwarfai-57working',
      'dwarfai-58working',
      'dwarfai-59working'
    ])
    expect(wrapper.find('button.dm-roster__more').attributes('aria-expanded')).toBe('true')
    ;(items[1] as HTMLElement).click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('pick')).toEqual([[dwarfs[5]]])
    expect(document.body.querySelector('.dm-menu__item')).toBeNull()
  })

  it('closes the menu on Esc and hands the focus back to +N', async () => {
    const wrapper = mount(CrewRoster, { props: { dwarfs: crew(6) }, attachTo: document.body })
    const more = wrapper.find('button.dm-roster__more')
    await more.trigger('click')
    await wrapper.vm.$nextTick()
    document.body
      .querySelector('.dm-menu')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector('.dm-menu__item')).toBeNull()
    expect(document.activeElement).toBe(more.element)
  })

  it('says "No dwarfs here yet." for an empty mine', () => {
    const wrapper = mount(CrewRoster, { props: { dwarfs: [] } })
    expect(wrapper.find('.dm-roster__empty').text()).toBe('No dwarfs here yet.')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('shows a portrait’s tooltip card on keyboard focus', async () => {
    const wrapper = mount(CrewRoster, { props: { dwarfs: crew(2) }, attachTo: document.body })
    await wrapper.findAll('button.dm-portrait')[1]!.trigger('focus')
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector('.dm-tip .dm-dtip__name')?.textContent).toBe('dwarfai-54')
  })
})
