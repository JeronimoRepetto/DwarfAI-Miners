// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import NavSlot from './NavSlot.vue'

describe('NavSlot', () => {
  it('is a named button holding its icon at 2x', () => {
    const slot = mount(NavSlot, { props: { icon: 'map', label: 'Map' } })
    expect(slot.element.tagName).toBe('BUTTON')
    expect(slot.classes()).toEqual(['dm-slot', 'm-mat'])
    expect(slot.attributes('aria-label')).toBe('Map')
    expect(slot.attributes('data-label')).toBe('Map')
    expect(slot.get('.dm-icon').classes()).toContain('dm-icon--x2')
    expect(slot.find('.dm-badge').exists()).toBe(false)
  })

  it('draws the needs-you badge on its corner, and updates it in place; 0 removes it', async () => {
    const slot = mount(NavSlot, { props: { icon: 'mines', label: 'Mines', badge: 1 } })
    const badge = slot.get('.dm-badge')
    expect(badge.classes()).toEqual(['dm-badge', 'dm-slot__badge'])
    expect(badge.text()).toBe('1')
    await slot.setProps({ badge: 12 })
    expect(slot.get('.dm-badge').text()).toBe('12')
    expect(slot.attributes('aria-label')).toBe('Mines, 12 need you')
    await slot.setProps({ badge: 0 })
    expect(slot.find('.dm-badge').exists()).toBe(false)
    expect(slot.attributes('aria-label')).toBe('Mines')
  })

  it('reports a click', async () => {
    const slot = mount(NavSlot, { props: { icon: 'map', label: 'Map' } })
    await slot.trigger('click')
    expect(slot.emitted('click')).toHaveLength(1)
  })
})
