// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PanelNav from './PanelNav.vue'
import PixelIcon from '../icon/PixelIcon.vue'

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

/*
 * APPENDED (ISSUE-265): the guild flag's two values, by the ids of US-GUILD-002. The flag is read
 * once by the App and handed down as `guild`; the nav draws the group or nothing at all.
 */
describe('PanelNav and the guild flag (ISSUE-265)', () => {
  const GUILD_SLOT_IDS = ['lab', 'market', 'union']

  it('[US-GUILD-002.AC01, BR-19, INV-110] with GUILD_AREAS_ENABLED off the nav has no guild group, takes no space and no control links to the three pages', async () => {
    const nav = mount(PanelNav, { props: { page: 'map', guild: false } })
    // Absent, not disabled or hidden: the nav's own children are the mark, the World group, the
    // spacer and the System group, with nothing in between that could take a line of the column.
    const children = Array.from((nav.element as HTMLElement).children)
    expect(children.map((el) => [el.className, el.getAttribute('aria-label')])).toEqual([
      ['dm-nav__mark', 'Hide the panel'],
      ['dm-nav__group', 'World'],
      ['dm-nav__spacer', null],
      ['dm-nav__group', 'System']
    ])
    expect(nav.find('.dm-nav__rule').exists()).toBe(false)
    expect(nav.find('[disabled], [hidden]').exists()).toBe(false)
    for (const id of GUILD_SLOT_IDS) expect(nav.find(`[data-slot="${id}"]`).exists()).toBe(false)
    for (const name of ['Guild', 'Lab', 'Market', 'Laboral Union'])
      expect(nav.find(`[aria-label="${name}"], [data-label="${name}"]`).exists()).toBe(false)
    // Pressing every control the nav has never asks for a guild area.
    for (const button of nav.findAll('button')) await button.trigger('click')
    const asked = (nav.emitted('nav') ?? []).map(([area]) => area)
    expect(asked).not.toContain('lab')
    expect(asked).not.toContain('market')
    expect(asked).not.toContain('laboral-union')
  })

  it('[US-GUILD-002.AC02, US-GUILD-002.AC05] with the flag on the group named Guild shows the Lab, Market and Laboral Union slots, each opening its page', async () => {
    const nav = mount(PanelNav, { props: { page: 'map', guild: true } })
    const guild = group(nav, 'Guild')
    expect(guild.exists()).toBe(true)
    expect(guild.attributes('role')).toBe('group')
    expect(guild.attributes('aria-label')).toBe('Guild')
    const slots = guild.findAll('.dm-slot')
    expect(slots.map((s) => [s.attributes('data-slot'), s.attributes('aria-label')])).toEqual([
      ['lab', 'Lab'],
      ['market', 'Market'],
      ['union', 'Laboral Union']
    ])
    for (const one of slots) await one.trigger('click')
    expect(nav.emitted('nav')).toEqual([['lab'], ['market'], ['laboral-union']])
  })

  it('[US-GUILD-002.AC04] either flag value leaves the rest of the nav unchanged', () => {
    const rest = (guild: boolean) => {
      const nav = mount(PanelNav, { props: { page: 'mines', guild, badge: 1, music: true } })
      return Array.from((nav.element as HTMLElement).children)
        .filter((el) => el.getAttribute('aria-label') !== 'Guild')
        .map((el) => el.outerHTML)
    }
    const off = rest(false)
    expect(off).toEqual(rest(true))
    // The rest is the mark, the World group, the spacer and the System group with its lever.
    expect(off).toHaveLength(4)
    expect(off[3]).toContain('dm-nav__lever')
  })
})

describe('PanelNav, hidden until built (ISSUE-267)', () => {
  it('[ADR-034, BR-19] draws no mode lever at all when the build ships no mode beyond the Panel', () => {
    const nav = mount(PanelNav, { props: { page: 'map', modes: [] } })
    // Absent, not disabled: no group, no slot, nothing that takes a row of the System group.
    expect(nav.find('.dm-nav__lever').exists()).toBe(false)
    expect(nav.find('[aria-label="Mode"]').exists()).toBe(false)
    expect(nav.text()).not.toContain('MODE')
    expect(nav.findAll('.dm-slot').map((found) => found.attributes('data-label'))).toEqual([
      'Map',
      'Mines',
      'Settings',
      'Music'
    ])
  })

  it('[ADR-034] draws only the lever sides the build ships: "▼ Veta" alone between Veta and Valle', async () => {
    const nav = mount(PanelNav, { props: { page: 'map', modes: ['veta'] } })
    const lever = nav.get('.dm-nav__lever')
    expect(lever.findAll('.dm-slot').map((found) => found.attributes('data-label'))).toEqual([
      '▼ Veta'
    ])
    await lever.get('.dm-slot').trigger('click')
    expect(nav.emitted('mode')).toEqual([['veta']])
  })
})

/*
 * APPENDED (ISSUE-262): the Mines slot's needs-you badge and name, and the Music slot's pressed
 * state, by the ids of US-SHELL-003 and US-SHELL-005. The count is the Host's (ADR-033 item 3),
 * handed down as `badge`; the nav only draws it.
 */
describe('PanelNav, the needs-you badge and the Music slot (ISSUE-262)', () => {
  it('[US-SHELL-003.AC02, US-SHELL-003.AC03, US-SHELL-003.AC04, NFR-A11Y-09] the Mines slot has no badge with nobody waiting, and otherwise shows the count with the singular or plural needs-you name', () => {
    const none = slot(mount(PanelNav, { props: { page: 'map', badge: 0 } }), 'Mines')
    expect(none.find('.dm-badge').exists()).toBe(false)
    expect(none.attributes('aria-label')).toBe('Mines')

    const one = slot(mount(PanelNav, { props: { page: 'map', badge: 1 } }), 'Mines')
    expect(one.get('.dm-badge').text()).toBe('1')
    expect(one.attributes('aria-label')).toBe('Mines, 1 needs you')

    for (const count of [2, 3, 12]) {
      const many = slot(mount(PanelNav, { props: { page: 'map', badge: count } }), 'Mines')
      expect(many.get('.dm-badge').text()).toBe(String(count))
      expect(many.attributes('aria-label')).toBe(`Mines, ${count} need you`)
    }
  })

  it('[US-SHELL-005.AC01, US-SHELL-005.AC02, US-SHELL-005.AC03] the Music slot is pressed with its lit icon while music plays, and unpressed with its dim icon while it does not', async () => {
    const nav = mount(PanelNav, { props: { page: 'map', music: true } })
    expect(slot(nav, 'Music').attributes('aria-pressed')).toBe('true')
    expect(slot(nav, 'Music').findComponent(PixelIcon).props('name')).toBe('music-on')
    await nav.setProps({ music: false })
    expect(slot(nav, 'Music').attributes('aria-pressed')).toBe('false')
    expect(slot(nav, 'Music').findComponent(PixelIcon).props('name')).toBe('music-off')
  })

  it('[US-SHELL-005.AC04] a pressed Music slot never takes the gold current-page mark, whichever page is shown', () => {
    for (const page of ['map', 'mines', 'settings'] as const) {
      const nav = mount(PanelNav, { props: { page, music: true } })
      expect(slot(nav, 'Music').attributes('aria-current')).toBeUndefined()
      // The current-page mark stays on the page's own slot alone.
      expect(nav.findAll('[aria-current="page"]')).toHaveLength(1)
    }
  })
})
