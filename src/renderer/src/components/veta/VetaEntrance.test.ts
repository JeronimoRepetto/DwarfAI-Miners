// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { LANTERN_STEADY_OPACITY } from '../../lib/veta/lantern'
import { fakeAnimations, type FakeAnimations } from './testing/fakeAnimations'
import VetaEntrance from './VetaEntrance.vue'

/*
 * ISSUE-292 (TC-292-03): the closed entrance's lantern under reduced motion, and its lamp brightening as the first dwarf
 * arrives (07 S26.01; `DS/docs/motion.md`, "Veta, no sessions → working": the lamp's light jumps to 1 and stops
 * flickering, a class with no transition). The lantern loop plays on a hand-written Web Animations stand-in.
 */

let wrapper: VueWrapper | undefined
let motion: FakeAnimations | undefined
const matchMedia = window.matchMedia
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  motion?.restore()
  motion = undefined
  window.matchMedia = matchMedia
})

function prefersReducedMotion(on: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes('prefers-reduced-motion: reduce'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

/** The glow as drawn: one steady cell's opacity, or `loop` when the strip plays. */
function glow(): string {
  const strip = wrapper!.find('.veta-entrance__strip')
  if (strip.exists()) return 'loop'
  return (wrapper!.get('.veta-entrance__glow > .veta-entrance__cell').element as HTMLElement).style
    .opacity
}

describe('VetaEntrance', () => {
  it('[US-SHELL-011.AC04, NFR-A11Y-10] with reduced motion on the entrance lantern holds a steady light', async () => {
    prefersReducedMotion(true)
    motion = fakeAnimations()
    wrapper = mount(VetaEntrance, { props: { first: false, vertical: false } })
    // Nothing loops: no animation was asked of the browser, and the glow holds one steady light.
    expect(motion.runs).toEqual([])
    expect(glow()).toBe(String(LANTERN_STEADY_OPACITY.plain))
    await wrapper.setProps({ first: true })
    expect(glow()).toBe(String(LANTERN_STEADY_OPACITY.first))
    // Lit for an arrival, it is steady still, at full light.
    await wrapper.setProps({ first: false, lit: true })
    expect(glow()).toBe('1')
    expect(motion.runs).toEqual([])
  })

  it('[US-VETA-007.AC01, S26.01] the lit entrance lamp jumps to full light and stops flickering', async () => {
    prefersReducedMotion(false)
    motion = fakeAnimations()
    wrapper = mount(VetaEntrance, { props: { first: false, vertical: false } })
    expect(glow()).toBe('loop')
    const loop = motion.runs[0]!
    expect(loop.options.iterations).toBe(Infinity)
    expect(wrapper.get('[data-veta-entrance]').classes()).not.toContain('is-lit')

    await wrapper.setProps({ lit: true })
    expect(wrapper.get('[data-veta-entrance]').classes()).toContain('is-lit')
    expect(loop.cancelled).toBe(true)
    expect(glow()).toBe('1')
    expect(motion.runs).toHaveLength(1)
  })
})
