// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { UNAVAILABLE_ART_SRC } from '../../lib/art'
import GuildPage from './GuildPage.vue'

/*
 * This file replaces UnavailablePanel.test.ts, REMOVED for #635 with
 * UnavailablePanel.vue, which the guild page replaces (handoff.md, component
 * mapping). Its cases and where each guarantee lives now: "says the lab / the
 * market / the Laboral Union is being rebuilt, in the design’s own words" are
 * the three wording cases below, in the redesign's words; "draws each feature
 * over its own painting" and "draws the union over its own painting, not a
 * neighbour’s" are the painting case; "offers nothing to press, because the
 * design offers nothing to do" is the last case. "is announced as a status
 * rather than as an error" went with the role it tested: the redesign's
 * message is plain text in a region named after the area (components.md, Guild
 * pages, Accessibility), and nothing about it changes while it is shown.
 */
describe('GuildPage', () => {
  it('is a region named after its area, under a page header carrying that name', () => {
    const page = mount(GuildPage, { props: { area: 'laboral-union' } })
    expect(page.element.tagName).toBe('SECTION')
    expect(page.classes()).toEqual(['dm-guild'])
    expect(page.attributes('aria-label')).toBe('Laboral Union')
    expect(page.get('header.dm-phead h1.dm-phead__title').text()).toBe('Laboral Union')
  })

  it.each([
    ['lab', 'Lab', 'Experiments with new tools and outfits for your dwarfs.'],
    ['market', 'Market', 'Trade ore for gear and skins.'],
    ['laboral-union', 'Laboral Union', 'Rules for how your crews work and rest.']
  ] as const)('says %s is not open yet, in the design’s own words', (area, name, text) => {
    const page = mount(GuildPage, { props: { area } })
    expect(page.attributes('aria-label')).toBe(name)
    const plate = page.get('.dm-guild__plate')
    expect(plate.get('h2').text()).toBe('Not open yet')
    expect(plate.get('p').text()).toBe(text + ' This area is being built.')
  })

  it('draws each area over its own painting, under the veil', () => {
    for (const area of ['lab', 'market', 'laboral-union'] as const) {
      const page = mount(GuildPage, { props: { area } })
      const art = page.get('.dm-guild__well .dm-guild__art')
      expect(art.attributes('style')).toContain(UNAVAILABLE_ART_SRC[area])
      expect(art.find('.dm-guild__veil .dm-guild__plate').exists()).toBe(true)
    }
  })

  it('carries the area’s icon on its plate', () => {
    const page = mount(GuildPage, { props: { area: 'market' } })
    expect(page.get('.dm-guild__plate .dm-icon').classes()).toContain('dm-icon--x2')
  })

  it('offers nothing to press, because the design offers nothing to do', () => {
    const page = mount(GuildPage, { props: { area: 'lab' } })
    expect(page.findAll('button, a, input')).toHaveLength(0)
  })
})

/*
 * APPENDED (ISSUE-265): the guild pages by the ids of US-GUILD-001. The words below are the
 * stories' own, written here by hand rather than read back from lib/shell/guildPage.
 */
const AREAS = ['lab', 'market', 'laboral-union'] as const

const STORY = {
  lab: {
    title: 'Lab',
    line: 'Experiments with new tools and outfits for your dwarfs. This area is being built.'
  },
  market: { title: 'Market', line: 'Trade ore for gear and skins. This area is being built.' },
  'laboral-union': {
    title: 'Laboral Union',
    line: 'Rules for how your crews work and rest. This area is being built.'
  }
} as const

/*
 * The SHA-256 of each painting as the PO supplied it: the design repository's
 * prototype/assets/guild/<area>.png at d12d3fc, which the bundled file must equal byte for byte
 * (TC-265-02). guild-pages.golden.test.mjs compares against the design checkout itself.
 */
const SUPPLIED_ART_SHA256 = {
  lab: 'eeb5222c40aa82bcc095d33a837723e71b8adf85a00783d746c7569efc8fe813',
  market: 'daeb8e0808593c27b7cc9fcae0e4bf7a2326148015e291cc91c269b019067c26',
  'laboral-union': '8fdc4ef286a6278105947acc7aa682638f8a670023c7d746ded2f37d6681897e'
} as const

const ART_DIR = join(import.meta.dirname, '..', '..', 'assets', 'art')

/** The DOM events test-utils records on the root by itself; none of them is the page's own. */
const NATIVE = new Set(['click', 'keydown', 'pointerdown'])

describe('GuildPage by the guild stories (ISSUE-265)', () => {
  it('[US-GUILD-001.AC01, US-GUILD-001.AC04] each guild page shows its own supplied art unchanged, Not open yet and its line, and nothing else', () => {
    for (const area of AREAS) {
      const bytes = readFileSync(join(ART_DIR, area, `${area}.png`))
      expect(createHash('sha256').update(bytes).digest('hex'), area).toBe(SUPPLIED_ART_SHA256[area])

      const page = mount(GuildPage, { props: { area } })
      expect(page.get('.dm-guild__art').attributes('style')).toContain(UNAVAILABLE_ART_SRC[area])
      for (const other of AREAS.filter((one) => one !== area))
        expect(page.html()).not.toContain(UNAVAILABLE_ART_SRC[other])
      // Nothing else: the page header's title, the plate's icon, its headline and its line.
      expect(page.findAll('h1, h2, p').map((el) => el.text())).toEqual([
        STORY[area].title,
        'Not open yet',
        STORY[area].line
      ])
      expect(page.text()).toBe(STORY[area].title + 'Not open yet' + STORY[area].line)
      // The one drawing besides the painting is the area's icon on the plate.
      const drawn = page.findAll('img, svg, canvas, video')
      expect(drawn).toHaveLength(1)
      expect(drawn[0]!.element.closest('.dm-guild__plate .dm-icon')).not.toBeNull()
    }
  })

  it('[US-GUILD-001.AC05, US-GUILD-001.AC06, US-GUILD-001.AC07] Lab, Market and Laboral Union show their titles and messages', () => {
    for (const area of AREAS) {
      const page = mount(GuildPage, { props: { area } })
      expect(page.get('h1').text()).toBe(STORY[area].title)
      expect(page.attributes('aria-label')).toBe(STORY[area].title)
      expect(page.get('.dm-guild__plate h2').text()).toBe('Not open yet')
      expect(page.get('.dm-guild__plate p').text()).toBe(STORY[area].line)
    }
  })

  it('[US-GUILD-001.AC02] nothing on a guild page but the nav reacts to input', async () => {
    for (const area of AREAS) {
      const page = mount(GuildPage, { props: { area } })
      const before = page.html()
      const controls =
        'button, a, input, select, textarea, [tabindex], [role="button"], [contenteditable]'
      expect(page.findAll(controls)).toHaveLength(0)
      for (const el of [page, ...page.findAll('*')]) {
        await el.trigger('click')
        await el.trigger('keydown', { key: 'Enter' })
        await el.trigger('pointerdown')
      }
      expect(Object.keys(page.emitted()).filter((name) => !NATIVE.has(name))).toEqual([])
      expect(page.html()).toBe(before)
    }
  })

  it('[US-GUILD-001.AC03] moving from one guild page to another replaces art and message with nothing carried over', async () => {
    const page = mount(GuildPage, { props: { area: 'lab' } })
    for (const area of ['market', 'laboral-union', 'lab'] as const) {
      await page.setProps({ area })
      expect(page.html()).toBe(mount(GuildPage, { props: { area } }).html())
      for (const other of AREAS.filter((one) => one !== area)) {
        expect(page.html()).not.toContain(UNAVAILABLE_ART_SRC[other])
        expect(page.text()).not.toContain(STORY[other].line)
      }
    }
  })
})
