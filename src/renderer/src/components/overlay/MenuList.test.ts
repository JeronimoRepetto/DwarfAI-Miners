// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MenuList from './MenuList.vue'
import type { MenuEntry } from '../../lib/overlay/menu'

const items: MenuEntry[] = [
  { label: 'Fold worktrees', hint: '3' },
  { separator: true },
  { label: 'Remove mine…', danger: true }
]

describe('MenuList', () => {
  it('is a menu of menuitems, a rule between groups, and a hint at the row end', () => {
    const menu = mount(MenuList, { props: { items } })
    expect(menu.attributes('role')).toBe('menu')
    const rows = menu.findAll('[role="menuitem"]')
    expect(rows.map((r) => r.text())).toEqual(['Fold worktrees3', 'Remove mine…'])
    expect(rows[0]!.get('.dm-menu__hint').text()).toBe('3')
    expect(menu.find('hr[role="separator"]').exists()).toBe(true)
    expect(rows[1]!.classes()).toContain('dm-menu__item--danger')
  })

  it('picks an item by its index, and never a disabled one', async () => {
    const menu = mount(MenuList, {
      props: { items: [{ label: 'A' }, { label: 'B', disabled: true }] }
    })
    const rows = menu.findAll('[role="menuitem"]')
    await rows[0]!.trigger('click')
    await rows[1]!.trigger('click')
    expect(menu.emitted('pick')).toEqual([[0]])
  })

  // ADDED for #635 (MESSAGE-QUESTIONS 13): a disabled item stays drawn and says why in its title.
  it('keeps a disabled item in place, with its reason as its title', () => {
    const menu = mount(MenuList, {
      props: { items: [{ label: 'Stop dwarf…', danger: true, disabled: true, title: 'Why' }] }
    })
    const row = menu.get('[role="menuitem"]')
    expect(row.attributes('disabled')).toBeDefined()
    expect(row.attributes('title')).toBe('Why')
  })

  it('moves the focus with the arrows, skipping the rule, and wraps', async () => {
    const menu = mount(MenuList, { props: { items }, attachTo: document.body })
    const rows = menu.findAll<HTMLButtonElement>('[role="menuitem"]')
    rows[0]!.element.focus()
    await rows[0]!.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1]!.element)
    await rows[1]!.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0]!.element)
    menu.unmount()
  })

  it('asks to close on Esc and on Tab', async () => {
    const menu = mount(MenuList, { props: { items } })
    const row = menu.findAll('[role="menuitem"]')[0]!
    await row.trigger('keydown', { key: 'Escape' })
    await row.trigger('keydown', { key: 'Tab' })
    expect(menu.emitted('close')).toHaveLength(2)
  })
})
