// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PanelNav from './PanelNav.vue'

/*
 * This file replaces ShellNav.test.ts, REMOVED for #635 with ShellNav.vue, the
 * v4 nav it tested; stated here, where its coverage went, rather than passing
 * unseen. Its cases and where each guarantee lives now:
 *
 * - "draws the six buttons the design names, in its order" and "gives every
 *   button a different icon": the groups below, lib/shell/panelNav.test.ts, and
 *   the four organisms/nav goldens, which grade every icon's pixels.
 * - "gives every button a real keyboard-reachable control": NavSlot.test.ts
 *   (every slot is a type=button <button>) and the mark case below.
 * - "marks exactly the selected area as pressed": the World group case below;
 *   the redesign marks it with aria-current, not aria-pressed.
 * - "names the area it was pressed for, and selects nothing itself": below.
 * - "carries the app mark above the stack", "makes the app mark the control
 *   that hides the window", "asks to be hidden, and hides nothing itself": the
 *   app mark case below, and App.test.ts's app mark cases.
 * - "draws each icon from the design’s own SVG rather than a substitute": gone
 *   with the SVG masks; the icon atom's registry (lib/icon) draws every glyph.
 * - "flags a broken shortcut on the settings button…" and "leaves the settings
 *   button unflagged…": the Settings warning case below.
 * - The music button's five: "draws it below the six areas, at the bottom of
 *   the column", "keeps one accessible name and carries the state on
 *   aria-pressed", "flips the glyph between the designer’s two music icons" and
 *   "asks for the toggle and changes nothing itself" live in the System group
 *   and Music cases below; "says what the current state does, so the tooltip is
 *   not just a label" went with the title it tested — a nav slot's tooltip is
 *   its rising label, the same word in both states.
 * - The press and hover feedback's four: "routes every control through
 *   motion.button carrying the shared variants", "has no disabled control in
 *   any state…", "grows a control under a hover and leaves the transform the
 *   fold wrote on the strip alone" went with the motion-v gesture the design
 *   replaced — a slot sinks one art pixel by CSS on its own box (NavSlot.vue),
 *   never on the nav's root; "leaves the root the plain navigation landmark the
 *   fold carries" is the first case below.
 */
const slot = (nav: ReturnType<typeof mount>, label: string) =>
  nav.get(`.dm-slot[data-label="${label}"]`)
const group = (nav: ReturnType<typeof mount>, name: string) =>
  nav.find(`.dm-nav__group[aria-label="${name}"]`)

describe('PanelNav', () => {
  it('is the Panel’s navigation landmark, one element the fold can carry', () => {
    const nav = mount(PanelNav, { props: { page: 'mines' } })
    expect(nav.element.tagName).toBe('NAV')
    expect(nav.classes()).toEqual(['dm-nav', 'm-mat'])
    expect(nav.attributes('aria-label')).toBe('Panel')
  })

  it('carries the app mark, which asks to hide the window and hides nothing itself', async () => {
    const nav = mount(PanelNav, { props: { page: 'mines' } })
    const mark = nav.get('button.dm-nav__mark')
    expect(mark.attributes('aria-label')).toBe('Hide the panel')
    expect(mark.attributes('title')).toBe('Hide the panel')
    expect(mark.get('.dm-icon').classes()).toContain('dm-icon--x2')
    await mark.trigger('click')
    expect(nav.emitted('mark')).toHaveLength(1)
  })

  it('draws the World group, Map then Mines, with the page shown marked current', () => {
    const nav = mount(PanelNav, { props: { page: 'mines' } })
    const world = group(nav, 'World')
    expect(world.attributes('role')).toBe('group')
    expect(world.findAll('.dm-slot').map((s) => s.attributes('data-label'))).toEqual([
      'Map',
      'Mines'
    ])
    expect(slot(nav, 'Mines').attributes('aria-current')).toBe('page')
    expect(slot(nav, 'Map').attributes('aria-current')).toBeUndefined()
    expect(slot(nav, 'Mines').attributes('data-slot')).toBe('mines')
  })

  it('badges Mines with how many need you, and names the count', () => {
    const nav = mount(PanelNav, { props: { page: 'map', badge: 2 } })
    expect(slot(nav, 'Mines').get('.dm-badge').text()).toBe('2')
    expect(slot(nav, 'Mines').attributes('aria-label')).toBe('Mines, 2 need you')
    expect(slot(nav, 'Map').find('.dm-badge').exists()).toBe(false)
  })

  it('has no Guild group at all while the guild areas are hidden', () => {
    const nav = mount(PanelNav, { props: { page: 'map' } })
    expect(group(nav, 'Guild').exists()).toBe(false)
    expect(nav.find('.dm-slot[data-label="Lab"]').exists()).toBe(false)
  })

  it('draws the Guild group, after a rule, once they are revealed', () => {
    const nav = mount(PanelNav, { props: { page: 'map', guild: true } })
    const guild = group(nav, 'Guild')
    expect(guild.element.firstElementChild?.className).toBe('dm-nav__rule')
    expect(guild.findAll('.dm-slot').map((s) => s.attributes('data-slot'))).toEqual([
      'lab',
      'market',
      'union'
    ])
  })

  it('names the area a slot was pressed for, and selects nothing itself', async () => {
    const nav = mount(PanelNav, { props: { page: 'mines', guild: true } })
    await slot(nav, 'Map').trigger('click')
    await slot(nav, 'Laboral Union').trigger('click')
    await slot(nav, 'Settings').trigger('click')
    expect(nav.emitted('nav')).toEqual([['map'], ['laboral-union'], ['settings']])
    expect(slot(nav, 'Mines').attributes('aria-current')).toBe('page')
  })

  it('puts the System group last, below the spacer: Settings, then the music toggle', () => {
    const nav = mount(PanelNav, { props: { page: 'settings' } })
    const children = Array.from((nav.element as HTMLElement).children).map((el) => el.className)
    expect(children.slice(-2)).toEqual(['dm-nav__spacer', 'dm-nav__group'])
    const system = group(nav, 'System')
    expect(system.findAll(':scope > .dm-slot').map((s) => s.attributes('data-label'))).toEqual([
      'Settings',
      'Music'
    ])
  })

  it('warns on Settings when the shortcut failed to register', () => {
    const nav = mount(PanelNav, { props: { page: 'map', warn: true } })
    expect(slot(nav, 'Settings').attributes('data-warn')).toBe('true')
    expect(
      mount(PanelNav, { props: { page: 'map' } })
        .find('[data-warn]')
        .exists()
    ).toBe(false)
  })

  it('makes Music a toggle stating whether it plays, and asks for the flip', async () => {
    const nav = mount(PanelNav, { props: { page: 'map', music: true } })
    const music = slot(nav, 'Music')
    expect(music.attributes('aria-pressed')).toBe('true')
    expect(music.attributes('aria-label')).toBe('Music')
    await nav.setProps({ music: false })
    expect(slot(nav, 'Music').attributes('aria-pressed')).toBe('false')
    await slot(nav, 'Music').trigger('click')
    expect(nav.emitted('music')).toHaveLength(1)
    // The verdict, never the wish: the press changes nothing here.
    expect(slot(nav, 'Music').attributes('aria-pressed')).toBe('false')
  })

  it('draws the mode lever at the bottom: ▲ Valle, the MODE label, ▼ Veta', async () => {
    const nav = mount(PanelNav, { props: { page: 'map' } })
    const lever = nav.get('.dm-nav__lever')
    expect(lever.attributes('role')).toBe('group')
    expect(lever.attributes('aria-label')).toBe('Mode')
    expect(
      Array.from(lever.element.children).map(
        (el) => el.getAttribute('aria-label') ?? el.textContent
      )
    ).toEqual(['▲ Valle', 'MODE', '▼ Veta'])
    await slot(nav, '▲ Valle').trigger('click')
    await slot(nav, '▼ Veta').trigger('click')
    expect(nav.emitted('mode')).toEqual([['valle'], ['veta']])
  })

  it('leaves out the mark and the lever for a host that carries its own, and takes its label', () => {
    const nav = mount(PanelNav, {
      props: { page: 'mines', mark: false, lever: false, label: 'Valle' }
    })
    expect(nav.attributes('aria-label')).toBe('Valle')
    expect(nav.find('.dm-nav__mark').exists()).toBe(false)
    expect(nav.find('.dm-nav__lever').exists()).toBe(false)
  })
})
