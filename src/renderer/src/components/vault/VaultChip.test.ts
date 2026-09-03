// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultMaterials } from '../../testing/factories'
import VaultChip from './VaultChip.vue'

describe('VaultChip', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /*
   * `.vault-ore` — one figure for every token at one flat rate — went with #22.
   * A single count across materials only means something if a coal nugget can
   * be traded for a gold one, and it cannot, so the chip now shows a labelled
   * entry per material (see the "per-material breakdown" block below). Both of
   * these keep their subject: the compact token gauge beside the breakdown.
   */
  it('shows the ore count and compact token total', () => {
    const wrapper = mount(VaultChip, {
      props: { tokensObserved: 25_000, materials: defaultMaterials({ bronze: 25_000 }) }
    })
    expect(wrapper.get('.vault-units').text()).toBe('2')
    expect(wrapper.get('.vault-tokens').text()).toBe('25K')
  })

  it('shows zero ore for a mine with no tokens observed yet', () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 0 } })
    expect(wrapper.get('.vault-empty').text()).toBe('no ore yet')
    expect(wrapper.get('.vault-tokens').text()).toBe('0')
  })

  it('never sparkles on the initial render', () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 1_000 } })
    expect(wrapper.get('.vault-chip').classes()).not.toContain('is-sparkling')
  })

  it('sparkles briefly when tokens grow, then settles', async () => {
    vi.useFakeTimers()
    const wrapper = mount(VaultChip, { props: { tokensObserved: 1_000 } })
    await wrapper.setProps({ tokensObserved: 2_000 })
    await nextTick()
    expect(wrapper.get('.vault-chip').classes()).toContain('is-sparkling')

    vi.advanceTimersByTime(1_000)
    await nextTick()
    expect(wrapper.get('.vault-chip').classes()).not.toContain('is-sparkling')
  })

  it('does not sparkle when tokens stay the same or decrease', async () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 2_000 } })
    await wrapper.setProps({ tokensObserved: 2_000 })
    expect(wrapper.get('.vault-chip').classes()).not.toContain('is-sparkling')
    await wrapper.setProps({ tokensObserved: 1_500 })
    expect(wrapper.get('.vault-chip').classes()).not.toContain('is-sparkling')
  })

  /*
   * AMENDED for #153's twelfth correction. This case named the `inline` variant,
   * which is gone: the mine interior passed it and then positioned the chip from
   * OUTSIDE, and `.vault-chip.is-inline { position: static }` — two classes plus
   * a scope attribute — out-specified MineScene's own one-class `.interior-vault
   * { position: absolute }`. The strip fell back into normal flow and floated at
   * the interior's TOP, which is exactly what the maintainer saw. A variant that
   * refuses to place itself and leaves its owner to try is the defect; `strip`
   * places itself, and the case below asserts that instead.
   */
  it('places itself along the bottom edge when variant is strip', () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 1_000, variant: 'strip' } })
    expect(wrapper.get('.vault-chip').classes()).toContain('is-strip')
    expect(wrapper.get('.vault-chip').classes()).not.toContain('is-floating')
  })

  it('leaves the map’s own corner chip floating', () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 1_000 } })
    expect(wrapper.get('.vault-chip').classes()).toContain('is-floating')
    expect(wrapper.get('.vault-chip').classes()).not.toContain('is-strip')
  })
})

/*
 * The per-material breakdown (see #22), and the one rule it exists to keep:
 * materials never convert into one another, so the chip lists them and never
 * adds them up. A single combined figure would only mean something if a coal
 * nugget could be traded for a gold one.
 */
describe('VaultChip per-material breakdown', () => {
  const MIXED = defaultMaterials({ coal: 25_000, gold: 300_000 })

  it('shows one labelled entry per material, poorest first', () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 125_000, materials: MIXED } })
    const entries = wrapper.findAll('.vault-material')
    expect(entries.map((entry) => entry.attributes('data-material'))).toEqual(['coal', 'gold'])
    expect(entries.map((entry) => entry.get('.vault-units').text())).toEqual(['10', '3'])
  })

  it('never renders one merged figure across materials', () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 125_000, materials: MIXED } })
    // 10 coal and 3 gold. "13" anywhere would be the conversion the vault refuses.
    for (const units of wrapper.findAll('.vault-units')) {
      expect(units.text()).not.toBe('13')
    }
    expect(wrapper.get('.vault-chip').attributes('aria-label')).toBe(
      'Vault: 10 coal, 3 gold. 125K tokens observed.'
    )
  })

  it('gives each pile its own painted ore and its own hover line', () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 125_000, materials: MIXED } })
    const [coal, gold] = wrapper.findAll('.vault-material')
    expect(coal?.attributes('title')).toBe('Coal ore — 10 mined (25K tokens)')
    expect(gold?.attributes('title')).toBe('Gold ore — 3 mined (300K tokens)')
    expect(coal?.get('img').attributes('src')).not.toBe(gold?.get('img').attributes('src'))
  })

  it('leaves out a material that has not reached one whole nugget', () => {
    const wrapper = mount(VaultChip, {
      props: { tokensObserved: 9_999, materials: defaultMaterials({ bronze: 9_999 }) }
    })
    expect(wrapper.findAll('.vault-material')).toHaveLength(0)
    expect(wrapper.get('.vault-empty').text()).toBe('no ore yet')
  })

  /*
   * `Mine.materials` and `MinesSnapshot.materials` are optional on the wire, so
   * a snapshot published before the ledger finished loading carries none. That
   * is an empty vault the chip can draw, not a crash.
   */
  it('draws an empty vault when the snapshot carries no breakdown at all', () => {
    const wrapper = mount(VaultChip, { props: { tokensObserved: 500 } })
    expect(wrapper.get('.vault-empty').text()).toBe('no ore yet')
    expect(wrapper.get('.vault-chip').attributes('aria-label')).toBe(
      'Vault: nothing mined yet. 500 tokens observed.'
    )
  })
})
