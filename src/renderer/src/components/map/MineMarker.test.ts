// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import MineMarker from './MineMarker.vue'
import markerSource from './MineMarker.vue?raw'

describe('MineMarker', () => {
  it('draws one hexagon carrying the mine’s tier', () => {
    const wrapper = mount(MineMarker, { props: { mine: defaultMine({ tier: 'gold' }) } })
    expect(wrapper.get('.mine-marker').attributes('data-tier')).toBe('gold')
    expect(wrapper.findAll('.marker-hex')).toHaveLength(1)
  })

  /*
    The tier a marker is DRAWN as, which for an unwalked project is the
    provisional bronze `tierOf()` hands out (#41). Drawing is exactly what that
    placeholder is for; nothing here records it anywhere.
  */
  it('draws an unwalked mine as the tier the board stamped for drawing', () => {
    const wrapper = mount(MineMarker, { props: { mine: defaultMine({ tier: 'bronze' }) } })
    expect(wrapper.get('.mine-marker').attributes('data-tier')).toBe('bronze')
  })

  it('emits open with the mine id when the marker is clicked', async () => {
    const wrapper = mount(MineMarker, {
      props: { mine: defaultMine({ id: 'C:/dev/beta', name: 'beta' }) }
    })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['C:/dev/beta']])
  })

  /*
    The marker itself is 10px wide and carries no text, so everything a screen
    reader or a keyboard user has to go on is this label. The design says
    nothing about either — accessibility is listed as needing definition — so
    the label carries what the tooltip carries, which is the most that is known.
  */
  it('names the mine, its tier and its crew for anyone not using a pointer', () => {
    const wrapper = mount(MineMarker, {
      props: {
        mine: defaultMine({ name: 'forge', tier: 'copper', dwarfs: [defaultDwarf()] })
      }
    })
    const label = wrapper.get('button').attributes('aria-label')
    expect(label).toContain('forge')
    expect(label).toContain('Cropper')
    expect(label).toContain('1')
  })

  it('is reachable by keyboard, being a real button', () => {
    const wrapper = mount(MineMarker, { props: { mine: defaultMine() } })
    expect(wrapper.get('button').attributes('type')).toBe('button')
  })
})

/*
 * The pulsing light the design asks for, and why #149's did not read as one
 * (#156).
 *
 * It animated a single property: the BLUR RADIUS of a drop-shadow painted in
 * the marker's own colour, from 2px to 7px and back. Around a 10px opaque
 * hexagon of that same colour, over a painted map, the difference between those
 * two is a few pixels of soft edge — nothing gets brighter, nothing gets bigger,
 * and nothing changes opacity. The maintainer's acceptance run reports what that
 * looks like: a flat dot that is hard to spot and does not appear to emit
 * anything.
 *
 * So the light is its own thing now, breathing in brightness and size behind a
 * hexagon that still never flickers — the design's own constraint, since the
 * shape says "mine" and the colour says which tier.
 *
 * Asserted against the stylesheet rather than through jsdom, which computes no
 * keyframes and no animation: the rendered result is verified in a real build.
 */
describe('the marker’s light', () => {
  /** The body of one CSS rule, by plain search — the selectors carry dots. */
  function styleRule(selector: string): string {
    const at = markerSource.indexOf('\n' + selector + ' {')
    if (at === -1) throw new Error(`no ${selector} rule in MineMarker.vue`)
    const open = markerSource.indexOf('{', at)
    const close = markerSource.indexOf('}', open)
    return markerSource.slice(open + 1, close)
  }

  /** Everything between a `@keyframes name {` and its matching close. */
  function keyframes(name: string): string {
    const at = markerSource.indexOf('@keyframes ' + name)
    if (at === -1) throw new Error(`no @keyframes ${name} in MineMarker.vue`)
    let depth = 0
    for (let i = markerSource.indexOf('{', at); i < markerSource.length; i++) {
      if (markerSource[i] === '{') depth += 1
      if (markerSource[i] === '}') {
        depth -= 1
        if (depth === 0) return markerSource.slice(at, i)
      }
    }
    throw new Error(`unterminated @keyframes ${name}`)
  }

  /** The reduced-motion block, which must hold the light rather than put it out. */
  function reducedMotionBlock(): string {
    const at = markerSource.indexOf('@media (prefers-reduced-motion: reduce)')
    if (at === -1) throw new Error('no reduced-motion block in MineMarker.vue')
    return markerSource.slice(at)
  }

  it('draws a light of its own, behind the hexagon', () => {
    const wrapper = mount(MineMarker, { props: { mine: defaultMine({ tier: 'gold' }) } })
    const inside = wrapper.get('.marker-hit').element.innerHTML
    expect(wrapper.findAll('.marker-light')).toHaveLength(1)
    expect(inside.indexOf('marker-light')).toBeLessThan(inside.indexOf('marker-hex'))
  })

  it('takes its colour from the tier, like everything else about the marker', () => {
    // A light in a colour that is not one of the five would say the wrong tier
    // louder than the hexagon says the right one.
    expect(styleRule('.marker-light')).toMatch(/var\(--marker-colour\)/)
  })

  it('pulses the light and never the hexagon, whose shape and colour identify the mine', () => {
    expect(styleRule('.marker-light')).toMatch(/animation:/)
    expect(styleRule('.marker-hex')).not.toMatch(/animation:/)
  })

  it('makes the pulse read as light: how bright and how big, not how blurred', () => {
    // The whole correction. A blur radius sweeping 2px to 7px is what the
    // acceptance run could not see.
    const frames = keyframes('marker-pulse')
    expect(frames).toMatch(/opacity:/)
    expect(frames).toMatch(/scale:/)
  })

  it('still lights the hexagon itself, so a marker is lit even between beats', () => {
    expect(styleRule('.marker-hex')).toMatch(/drop-shadow/)
  })

  it('holds the light steady for a viewer who asked for less movement', () => {
    // The contract #149 set and this keeps: reduced motion stops the pulsing,
    // it does not put the light out. A marker with no light reads as a
    // different kind of marker.
    const reduced = reducedMotionBlock()
    expect(reduced).toMatch(/\.marker-light\s*\{[^}]*animation:\s*none/)
    expect(reduced).toMatch(/\.marker-light\s*\{[^}]*opacity:\s*(?!0[^.\d])/)
  })
})
