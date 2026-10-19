// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import CrewRoster from './CrewRoster.vue'

// Every mounted wrapper is unmounted after its test, so no walk leg, fade or timer it started
// outlives the page a later test tears down (#635: CI caught one updating a removed column).
enableAutoUnmount(afterEach)

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

// Dwarf names (#635; decision log, Dwarf names): a portrait's accessible name is the custom name.
describe('CrewRoster, dwarf names (#635)', () => {
  it('names a renamed dwarf’s portrait by its custom name, any other by its base name', () => {
    const wrapper = mount(CrewRoster, {
      props: {
        dwarfs: [
          defaultDwarf({ id: 'r0', name: 'dwarfai-55', customName: 'Watcher', status: 'working' }),
          defaultDwarf({ id: 'r1', name: 'dwarfai-56', status: 'working' })
        ]
      }
    })
    expect(wrapper.findAll('button.dm-portrait').map((p) => p.attributes('aria-label'))).toEqual([
      'Watcher, working',
      'dwarfai-56, working'
    ])
  })
})

/*
 * APPENDED for ISSUE-255 (motion.md, Mine column or Valle zone, a dwarf arrives or leaves: "The
 * roster portrait — none: added or dropped at once"; organisms/mine-column, removeDwarf): the sprite
 * walks, the portrait does not. A departing dwarf stays on the board as 'leaving' while its sprite
 * walks out, and its portrait is already gone.
 */
describe('CrewRoster, arrivals and departures (ISSUE-255)', () => {
  it('[US-MINE-009.AC07] the roster portrait is added or dropped at once, independent of the sprite travel', async () => {
    const borin = defaultDwarf({ id: 'r0', name: 'dwarfai-53', status: 'working' })
    const dain = defaultDwarf({ id: 'r1', name: 'dwarfai-54', status: 'working' })
    const wrapper = mount(CrewRoster, { props: { dwarfs: [borin] } })
    const ids = () => wrapper.findAll('button.dm-portrait').map((p) => p.attributes('data-dwarf'))

    // An arrival: its portrait is there on the very render that brings it, while its sprite walks.
    await wrapper.setProps({ dwarfs: [borin, dain] })
    expect(ids()).toEqual(['r0', 'r1'])

    // A departure: walking out, still on the board, and its portrait already dropped.
    await wrapper.setProps({ dwarfs: [borin, { ...dain, status: 'leaving' }] })
    expect(ids()).toEqual(['r0'])
  })
})

/*
 * APPENDED for ISSUE-254: the roster as US-MINE-004 and US-MINE-005 read it. The row's never
 * scrolling is the stylesheet's (`overflow: hidden`, crew-roster.css rule for rule), read from the
 * component's own rules.
 */
describe('CrewRoster, the mine column (ISSUE-254)', () => {
  const SFC = readFileSync(join(import.meta.dirname, 'CrewRoster.vue'), 'utf8')
  const hints = (): string[] =>
    [...document.body.querySelectorAll('.dm-menu__item .dm-menu__hint')].map(
      (hint) => hint.textContent ?? ''
    )

  it('[US-MINE-004.AC01, US-MINE-004.AC02, US-MINE-004.AC06] five dwarfs or fewer get portraits; six or more show four portraits and a +n button named n more dwarfs, and the row never scrolls', () => {
    for (const count of [1, 2, 3, 4, 5]) {
      const wrapper = mount(CrewRoster, { props: { dwarfs: crew(count) } })
      expect(wrapper.findAll('button.dm-portrait'), String(count)).toHaveLength(count)
      expect(wrapper.find('.dm-roster__more').exists(), String(count)).toBe(false)
      wrapper.unmount()
    }
    for (const count of [6, 9, 30]) {
      const wrapper = mount(CrewRoster, { props: { dwarfs: crew(count) } })
      expect(wrapper.findAll('button.dm-portrait'), String(count)).toHaveLength(4)
      const more = wrapper.findAll('button.dm-roster__more')
      expect(more).toHaveLength(1)
      expect(more[0]!.text()).toBe('+' + (count - 4))
      expect(more[0]!.attributes('aria-label')).toBe(count - 4 + ' more dwarfs')
      wrapper.unmount()
    }
    expect(SFC).toMatch(/\.dm-roster \{[^}]*overflow: hidden;[^}]*\}/)
    expect(SFC).not.toMatch(/overflow(-x)?: (auto|scroll)/)
  })

  it('[US-MINE-004.AC03, US-MINE-004.AC04, US-MINE-004.AC05] a +N item opens that dwarf’s chat, Tab closes the menu and the hints use only working, idle or asleep', async () => {
    const rest = [
      defaultDwarf({ id: 'z', name: 'sleepy', status: 'waiting' }),
      defaultDwarf({ id: 'w', name: 'busy', status: 'working' }),
      defaultDwarf({ id: 'q', name: 'asks', status: 'waiting', waitingReason: 'approval' })
    ]
    const dwarfs = [...crew(4), ...rest]
    const wrapper = mount(CrewRoster, { props: { dwarfs }, attachTo: document.body })
    const more = wrapper.find('button.dm-roster__more')

    await more.trigger('click')
    await wrapper.vm.$nextTick()
    // The raw word for a dwarf that is not asking, "?" for one that is, and never "done".
    expect(hints()).toEqual(['asleep', 'working', '?'])
    for (const hint of hints().filter((word) => word !== '?')) {
      expect(['working', 'idle', 'asleep']).toContain(hint)
    }

    // Tab closes it.
    document.body
      .querySelector('.dm-menu')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector('.dm-menu__item')).toBeNull()
    expect(more.attributes('aria-expanded')).toBe('false')

    // An item does what pressing that dwarf's portrait does: the column selects it and opens it.
    await more.trigger('click')
    await wrapper.vm.$nextTick()
    ;(document.body.querySelectorAll('.dm-menu__item')[1] as HTMLElement).click()
    await wrapper.vm.$nextTick()
    await wrapper.findAll('button.dm-portrait')[0]!.trigger('click')
    expect(wrapper.emitted('pick')).toEqual([[rest[1]], [dwarfs[0]]])
  })

  it('[US-MINE-005.AC01, US-MINE-005.AC02, US-MINE-005.AC03] with no present dwarf the roster reads No dwarfs here yet. and an arriving dwarf replaces the empty state', async () => {
    const wrapper = mount(CrewRoster, { props: { dwarfs: [] } })
    expect(wrapper.find('.dm-roster').text()).toBe('No dwarfs here yet.')
    expect(wrapper.find('button').exists()).toBe(false)

    const arrived = defaultDwarf({ id: 'n1', name: 'newcomer', status: 'working' })
    await wrapper.setProps({ dwarfs: [arrived] })
    expect(wrapper.find('.dm-roster__empty').exists()).toBe(false)
    expect(wrapper.findAll('button.dm-portrait').map((p) => p.attributes('data-dwarf'))).toEqual([
      'n1'
    ])

    // Everyone has left since: the roster shows who is here, not who was, so it is empty again.
    await wrapper.setProps({ dwarfs: [{ ...arrived, status: 'leaving' }] })
    expect(wrapper.find('.dm-roster').text()).toBe('No dwarfs here yet.')
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
