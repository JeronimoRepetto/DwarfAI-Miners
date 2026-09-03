// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ShellArea } from '../../lib/shell/shellNav'
import ShellNav from './ShellNav.vue'

function mountNav(props: { area?: ShellArea; broken?: boolean } = {}) {
  return mount(ShellNav, { props: { area: 'map' as const, broken: false, ...props } })
}

describe('ShellNav', () => {
  it('draws the five buttons the design names, in its order', () => {
    const buttons = mountNav().findAll('.nav-button')
    expect(buttons.map((button) => button.attributes('aria-label'))).toEqual([
      'Settings',
      'Map',
      'Mines',
      'Lab',
      'Market'
    ])
  })

  it('gives every button a real keyboard-reachable control', () => {
    for (const button of mountNav().findAll('.nav-button')) {
      expect(button.element.tagName).toBe('BUTTON')
      expect(button.attributes('type')).toBe('button')
    }
  })

  it('marks exactly the selected area as pressed', () => {
    const nav = mountNav({ area: 'lab' })
    const pressed = nav
      .findAll('.nav-button')
      .filter((button) => button.attributes('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
    expect(pressed[0]!.attributes('aria-label')).toBe('Lab')
  })

  it('names the area it was pressed for, and selects nothing itself', () => {
    const nav = mountNav({ area: 'map' })
    nav.findAll('.nav-button')[2]!.trigger('click')
    expect(nav.emitted('select')).toEqual([['mines']])
    // Still on the map: the parent owns the view, this is a request.
    expect(nav.findAll('.nav-button')[1]!.attributes('aria-pressed')).toBe('true')
  })

  it('carries the app mark above the stack', () => {
    // The design puts it at the top of the panel's outer edge, with the stack
    // below it and vertically centred against the panel.
    const nav = mountNav()
    expect(nav.find('.nav-mark').exists()).toBe(true)
  })

  it('draws each icon from the design’s own SVG rather than a substitute', () => {
    // A missing icon has to fail loudly. Rendering an empty 19px square, or
    // quietly reusing a neighbour's glyph, is the failure this catches.
    for (const button of mountNav().findAll('.nav-button')) {
      const glyph = button.find('.nav-icon')
      expect(glyph.exists()).toBe(true)
      expect(glyph.attributes('style')).toMatch(/--nav-icon:\s*url\(/)
    }
  })

  it('gives every button a different icon', () => {
    const styles = mountNav()
      .findAll('.nav-icon')
      .map((glyph) => glyph.attributes('style'))
    expect(new Set(styles).size).toBe(styles.length)
  })

  /*
   * A shortcut the OS refused used to be flagged on the old titlebar's gear
   * (#17), where a failure the user only meets after opening settings is a
   * failure they never look for. The titlebar is gone; the flag moved here.
   */
  it('flags a broken shortcut on the settings button without anything being opened', () => {
    const nav = mountNav({ broken: true })
    const settings = nav.findAll('.nav-button')[0]!
    expect(settings.classes()).toContain('is-broken')
    expect(settings.attributes('title')).toMatch(/unavailable/i)
  })

  it('leaves the settings button unflagged when the shortcut works', () => {
    expect(mountNav().findAll('.nav-button')[0]!.classes()).not.toContain('is-broken')
  })
})
