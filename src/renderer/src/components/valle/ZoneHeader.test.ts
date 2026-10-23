// @vitest-environment jsdom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ZoneHeader from './ZoneHeader.vue'

enableAutoUnmount(afterEach)

/*
 * Valle QA VQA-14: the header's "· Map / · Mines / · History" was cut off at a normal column width,
 * because it sat inside the name, the one part that clips. The design (`DS` organisms/mine-zone,
 * mine-zone.js and mine-zone.css) draws `.dm-vz__what` as the name's sibling in the title, `flex:
 * none`, so a long name gives way with its ellipsis and what the zone shows stays readable.
 */
describe("a Valle zone's header gives way with its name, never its suffix", () => {
  const header = () =>
    mount(ZoneHeader, {
      props: { name: 'a-very-long-mine-name-that-will-not-fit', content: 'map', menuOpen: false }
    })

  it('[US-VALLE-009.AC01] draws what the zone shows beside the name, outside the part that clips', () => {
    const wrapper = header()
    const suffix = wrapper.get('[data-zone-suffix]')
    expect(suffix.text()).toBe('· Map')
    expect(suffix.element.closest('.dm-vz__name')).toBeNull()
    expect(suffix.element.parentElement?.classList.contains('dm-vz__title')).toBe(true)
  })

  it('[US-VALLE-009.AC01] keeps the full name in the name itself, for its ellipsis and its title', () => {
    const name = header().get('.dm-vz__name')
    expect(name.text()).toBe('a-very-long-mine-name-that-will-not-fit')
    expect(name.attributes('title')).toBe('a-very-long-mine-name-that-will-not-fit')
  })
})
