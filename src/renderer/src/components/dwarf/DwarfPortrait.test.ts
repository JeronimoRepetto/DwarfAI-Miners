// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { PORTRAIT_SRC } from '../../lib/art'
import { PORTRAIT_STATUSES } from '../../lib/dwarf/portrait'
import DwarfPortrait from './DwarfPortrait.vue'

describe('DwarfPortrait', () => {
  it('is a static figure by default: the face with empty alt, then the hidden mark', () => {
    const portrait = mount(DwarfPortrait, { props: { role: 'foreman' } })
    expect(portrait.element.tagName).toBe('SPAN')
    expect(portrait.attributes('data-status')).toBe('idle')
    expect(portrait.attributes('aria-label')).toBeUndefined()
    const [face, mark] = [...portrait.element.children]
    expect(face!.tagName).toBe('IMG')
    expect(face!.getAttribute('src')).toBe(PORTRAIT_SRC.foreman)
    expect(face!.getAttribute('alt')).toBe('')
    expect(mark!.className).toBe('dm-portrait__mark')
    expect(mark!.getAttribute('aria-hidden')).toBe('true')
    expect(mark!.textContent).toBe('')
  })

  it('is a named button when interactive, marking its status and reporting a click', async () => {
    const portrait = mount(DwarfPortrait, {
      props: { role: 'worker2', status: 'asking', name: 'b', interactive: true }
    })
    expect(portrait.element.tagName).toBe('BUTTON')
    expect(portrait.attributes('aria-label')).toBe('b, needs you')
    expect(portrait.attributes('aria-pressed')).toBe('false')
    expect(portrait.get('.dm-portrait__mark').text()).toBe('?')
    await portrait.trigger('click')
    expect(portrait.emitted('click')).toHaveLength(1)
  })

  it('swaps its mark in place when the status changes', async () => {
    const portrait = mount(DwarfPortrait, { props: { role: 'worker', status: 'working' } })
    await portrait.setProps({ status: 'asleep' })
    expect(portrait.attributes('data-status')).toBe('asleep')
    expect(portrait.get('.dm-portrait__mark').text()).toBe('z')
  })
})

/*
 * APPENDED for ISSUE-254: "done" is no status any more (PO #9; ADR-032), so the portrait draws no
 * look for it. Its stylesheet keeps a rule for each of the four statuses it can be handed and none
 * for a fifth.
 */
describe('DwarfPortrait, the four statuses (ISSUE-254)', () => {
  it('[US-OBS-004.AC07] the portrait styles only working, asking, idle and asleep, never done', () => {
    const source = readFileSync(join(import.meta.dirname, 'DwarfPortrait.vue'), 'utf8')
    const styled = [...source.matchAll(/data-status='([a-z]+)'/g)].map((match) => match[1])
    expect(styled.length).toBeGreaterThan(0)
    for (const status of styled) expect(PORTRAIT_STATUSES).toContain(status)
  })
})
