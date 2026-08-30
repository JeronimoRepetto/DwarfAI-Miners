// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { NUGGET_SRC } from '../../lib/art'
import { MAX_PILE_NUGGETS } from '../../lib/vault/nuggetPile'
import { MATERIAL_TOKENS_PER_UNIT } from '../../types'
import NuggetPile from './NuggetPile.vue'

/** Tokens that come to exactly `units` whole nuggets of `material`. */
function tokensFor(material: keyof typeof MATERIAL_TOKENS_PER_UNIT, units: number): number {
  return MATERIAL_TOKENS_PER_UNIT[material] * units
}

describe('NuggetPile', () => {
  it('draws one painted nugget per whole unit mined', () => {
    const wrapper = mount(NuggetPile, {
      props: { material: 'bronze', tokens: tokensFor('bronze', 7), seed: 'C:/dev/sample' }
    })
    expect(wrapper.findAll('.nugget')).toHaveLength(7)
  })

  it('draws nothing at all until the first whole nugget is out of the ground', () => {
    const wrapper = mount(NuggetPile, {
      props: { material: 'gold', tokens: MATERIAL_TOKENS_PER_UNIT.gold - 1, seed: 'mine' }
    })
    expect(wrapper.findAll('.nugget')).toHaveLength(0)
  })

  it('uses that material own painting, not a shared one', () => {
    const coal = mount(NuggetPile, {
      props: { material: 'coal', tokens: tokensFor('coal', 3), seed: 'mine' }
    })
    const gold = mount(NuggetPile, {
      props: { material: 'gold', tokens: tokensFor('gold', 3), seed: 'mine' }
    })
    expect(coal.get('.nugget').attributes('src')).toBe(NUGGET_SRC.coal)
    expect(gold.get('.nugget').attributes('src')).toBe(NUGGET_SRC.gold)
  })

  /*
   * The affordance the owner found missing: a heap that cannot say what it is
   * or how much it holds. The mound is one named image; the stones inside it
   * are brush strokes and are hidden from assistive technology so a screen
   * reader hears "Coal ore — 3 mined" and not twenty-one anonymous graphics.
   */
  it('says what it is and how much, to a pointer and to a screen reader', () => {
    const wrapper = mount(NuggetPile, {
      props: { material: 'coal', tokens: tokensFor('coal', 3), seed: 'mine' }
    })
    const mound = wrapper.get('.ore-mound')
    expect(mound.attributes('role')).toBe('img')
    expect(mound.attributes('title')).toBe('Coal ore — 3 mined (7.5K tokens)')
    expect(mound.attributes('aria-label')).toBe('Coal ore — 3 mined (7.5K tokens)')
    for (const nugget of wrapper.findAll('.nugget')) {
      expect(nugget.attributes('aria-hidden')).toBe('true')
    }
  })

  /*
   * The cap is what keeps a mine with millions of tokens from putting thousands
   * of nodes in a panel that repaints every two seconds.
   */
  it('never draws more than the mound can hold, however rich the seam', () => {
    const wrapper = mount(NuggetPile, {
      props: { material: 'bronze', tokens: tokensFor('bronze', 400_000), seed: 'mine' }
    })
    expect(wrapper.findAll('.nugget')).toHaveLength(MAX_PILE_NUGGETS)
  })

  it('keeps carrying the growth past the cap, by count and by size', () => {
    const wrapper = mount(NuggetPile, {
      props: { material: 'bronze', tokens: tokensFor('bronze', 1_400), seed: 'mine' }
    })
    expect(wrapper.get('.pile-count').text()).toBe('1.4K')
    // The real count is still in the label, uncompacted and unrounded.
    expect(wrapper.get('.ore-mound').attributes('title')).toContain('1400 mined')
    expect(wrapper.get('.ore-mound').attributes('style')).toContain('--mound-scale')
  })

  it('shows no count while the mound still holds every nugget mined', () => {
    const wrapper = mount(NuggetPile, {
      props: {
        material: 'bronze',
        tokens: tokensFor('bronze', MAX_PILE_NUGGETS),
        seed: 'mine'
      }
    })
    expect(wrapper.findAll('.nugget')).toHaveLength(MAX_PILE_NUGGETS)
    expect(wrapper.find('.pile-count').exists()).toBe(false)
  })

  /*
   * The panel re-mounts and re-renders on every poll. A pile that re-rolled its
   * own jitter each time would twitch continuously in the corner of the eye,
   * which is why the offsets come from a hash of the pile's identity.
   */
  it('lays the same pile out identically every time the panel repaints', () => {
    const props = {
      material: 'silver',
      tokens: tokensFor('silver', 9),
      seed: 'C:/dev/sample'
    } as const
    const first = mount(NuggetPile, { props })
    const second = mount(NuggetPile, { props })
    expect(second.findAll('.nugget').map((n) => n.attributes('style'))).toEqual(
      first.findAll('.nugget').map((n) => n.attributes('style'))
    )
  })

  it('gives two mines heaps that do not look cloned', () => {
    const alpha = mount(NuggetPile, {
      props: { material: 'copper', tokens: tokensFor('copper', 9), seed: 'C:/dev/alpha' }
    })
    const beta = mount(NuggetPile, {
      props: { material: 'copper', tokens: tokensFor('copper', 9), seed: 'C:/dev/beta' }
    })
    expect(beta.findAll('.nugget').map((n) => n.attributes('style'))).not.toEqual(
      alpha.findAll('.nugget').map((n) => n.attributes('style'))
    )
  })

  it('tilts the stones so the mound does not read as a grid', () => {
    const wrapper = mount(NuggetPile, {
      props: { material: 'bronze', tokens: tokensFor('bronze', MAX_PILE_NUGGETS), seed: 'mine' }
    })
    const rotations = wrapper.findAll('.nugget').map((n) => n.attributes('style') ?? '')
    expect(rotations.every((style) => style.includes('rotate'))).toBe(true)
    expect(new Set(rotations).size).toBeGreaterThan(1)
  })
})
