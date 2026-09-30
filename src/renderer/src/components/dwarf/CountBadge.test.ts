// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CountBadge from './CountBadge.vue'
import StatePill from './StatePill.vue'

describe('CountBadge', () => {
  it('shows its count, hidden from assistive tech: the control it sits on names the count', () => {
    const badge = mount(CountBadge, { props: { count: 3, tone: 'info' } })
    expect(badge.element.tagName).toBe('SPAN')
    expect(badge.classes()).toEqual(['dm-badge', 'dm-badge--info'])
    expect(badge.attributes('aria-hidden')).toBe('true')
    expect(badge.text()).toBe('3')
  })

  it('overflows a count past 99', () => {
    expect(mount(CountBadge, { props: { count: 140 } }).text()).toBe('99+')
  })
})

describe('StatePill', () => {
  it('is plain text that reads as it shows', () => {
    const pill = mount(StatePill, { props: { text: 'idle' } })
    expect(pill.element.tagName).toBe('SPAN')
    expect(pill.classes()).toEqual(['dm-pill'])
    expect(pill.attributes('aria-hidden')).toBeUndefined()
    expect(pill.text()).toBe('idle')
  })

  it('draws the needs-you plate before the word, a question by default', () => {
    const pill = mount(StatePill, { props: { text: '1 needs you', tone: 'needs', ask: true } })
    expect(pill.classes()).toEqual(['dm-pill', 'dm-pill--needs'])
    const plate = pill.get('.dm-pill__q')
    expect(plate.text()).toBe('?')
    expect(pill.element.firstElementChild).toBe(plate.element)
    expect(pill.text()).toBe('?1 needs you')
  })

  it("marks a permission's plate with its own mark", () => {
    const pill = mount(StatePill, { props: { text: 'x', ask: true, mark: '!' } })
    expect(pill.get('.dm-pill__q').text()).toBe('!')
  })

  it('draws an icon before the word at 1x', () => {
    const pill = mount(StatePill, { props: { text: 'done', tone: 'ok', icon: 'check' } })
    const icon = pill.get('.dm-icon')
    expect(icon.classes()).toContain('dm-icon--x1')
    expect(pill.element.firstElementChild).toBe(icon.element)
    expect(pill.find('.dm-pill__q').exists()).toBe(false)
  })
})
