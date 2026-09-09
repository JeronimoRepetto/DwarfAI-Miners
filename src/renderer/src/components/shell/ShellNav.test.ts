// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ShellArea } from '../../lib/shell/shellNav'
import ShellNav from './ShellNav.vue'

function mountNav(props: { area?: ShellArea; broken?: boolean; musicPlaying?: boolean } = {}) {
  return mount(ShellNav, {
    props: { area: 'map' as const, broken: false, musicPlaying: true, ...props }
  })
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

  /*
   * AMENDED for #156's second correction. #153 made the mark the control that
   * collapsed the whole shell into the rail; the maintainer's ruling now is that
   * it HIDES the window outright, exactly as the global shortcut does. The two
   * other controls keep the jobs #153 gave them — the arrow closes the left
   * page, the interior's round close closes the right one — so collapsing into
   * the rail is still reachable, and this control stops being a third way to do
   * something the arrow already does.
   *
   * Both cases kept their subject: the mark is still a real button that decides
   * nothing itself. What changed is which action it names and asks for.
   */
  it('makes the app mark the control that hides the window', () => {
    const nav = mountNav()
    const mark = nav.find('.nav-mark')
    expect(mark.element.tagName).toBe('BUTTON')
    expect(mark.attributes('type')).toBe('button')
    expect(mark.attributes('aria-label')).toMatch(/hide/i)
    expect(mark.attributes('aria-label')).not.toMatch(/collapse/i)
  })

  it('asks to be hidden, and hides nothing itself', () => {
    // Same rule the rail already keeps: the window is main's, so this reports
    // the press and lets main answer for the window.
    const nav = mountNav()
    nav.find('.nav-mark').trigger('click')
    expect(nav.emitted('hide')).toHaveLength(1)
    expect(nav.emitted('select')).toBeUndefined()
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

/*
 * The music button (#174), at the bottom of the navigation column.
 *
 * Here rather than in a component of its own because the column IS the bottom
 * of the shell: the mark sits at its top, the five areas are centred against
 * the panel, and this is what is left below them. It decides nothing, for the
 * reason the mark and the rail's arrow decide nothing — playback belongs to
 * the audio engine, which App.vue owns.
 */
describe('ShellNav — the music button', () => {
  it('draws it below the five areas, at the bottom of the column', () => {
    const nav = mountNav()
    const button = nav.find('.nav-music')
    expect(button.exists()).toBe(true)
    expect(button.element.tagName).toBe('BUTTON')
    expect(button.attributes('type')).toBe('button')
  })

  it('keeps one accessible name and carries the state on aria-pressed', () => {
    // The same rule the pin control holds: the name stays stable so a screen
    // reader is not told the control changed identity, and the STATE is what
    // moves.
    const playing = mountNav({ musicPlaying: true })
    const stopped = mountNav({ musicPlaying: false })
    expect(playing.find('.nav-music').attributes('aria-label')).toBe(
      stopped.find('.nav-music').attributes('aria-label')
    )
    expect(playing.find('.nav-music').attributes('aria-pressed')).toBe('true')
    expect(stopped.find('.nav-music').attributes('aria-pressed')).toBe('false')
  })

  it('flips the glyph between the designer’s two music icons', () => {
    const playing = mountNav({ musicPlaying: true }).find('.music-icon').attributes('style')
    const stopped = mountNav({ musicPlaying: false }).find('.music-icon').attributes('style')
    expect(playing).toMatch(/--music-icon:\s*url\(/)
    expect(stopped).toMatch(/--music-icon:\s*url\(/)
    expect(playing).not.toBe(stopped)
  })

  it('says what the current state does, so the tooltip is not just a label', () => {
    expect(mountNav({ musicPlaying: true }).find('.nav-music').attributes('title')).toMatch(/stop/i)
    expect(mountNav({ musicPlaying: false }).find('.nav-music').attributes('title')).toMatch(
      /play/i
    )
  })

  it('asks for the toggle and changes nothing itself', () => {
    const nav = mountNav({ musicPlaying: true })
    nav.find('.nav-music').trigger('click')
    expect(nav.emitted('toggle-music')).toHaveLength(1)
    expect(nav.emitted('select')).toBeUndefined()
    // Still drawn as playing: the engine above owns whether it is.
    expect(nav.find('.nav-music').attributes('aria-pressed')).toBe('true')
  })
})
