// @vitest-environment jsdom
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
