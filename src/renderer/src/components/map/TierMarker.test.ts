// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TierMarker from './TierMarker.vue'
import markerSource from './TierMarker.vue?raw'

describe('TierMarker', () => {
  it('is a named button: the pulse halo, then the tier gem', () => {
    const marker = mount(TierMarker, { props: { tier: 'gold' } })
    expect(marker.element.tagName).toBe('BUTTON')
    expect(marker.attributes('aria-label')).toBe('Gold mine')
    expect(marker.attributes('data-tier')).toBe('gold')
    const [pulse, gem] = [...marker.element.children]
    expect(pulse!.className).toBe('dm-marker__pulse')
    expect(gem!.className).toBe('dm-marker__gem')
    expect(gem!.children).toHaveLength(0)
  })

  it('draws the "?" inside the gem when a dwarf there needs you', () => {
    const marker = mount(TierMarker, { props: { tier: 'silver', asking: true } })
    expect(marker.classes()).toContain('dm-marker--ask')
    expect(marker.get('.dm-marker__gem .dm-marker__q').text()).toBe('?')
  })

  it('reports a click', async () => {
    const marker = mount(TierMarker, { props: { tier: 'bronze' } })
    await marker.trigger('click')
    expect(marker.emitted('click')).toHaveLength(1)
  })
})

describe('TierMarker under reduced motion (#635)', () => {
  const REDUCED = '@media (prefers-reduced-motion: reduce)'

  /** The declarations of `selector` inside the reduced-motion block of the marker's style. */
  function reducedRule(selector: string): Map<string, string> {
    const at = markerSource.indexOf(REDUCED)
    if (at === -1) throw new Error('no reduced-motion block in TierMarker.vue')
    const block = markerSource.slice(at, markerSource.indexOf('</style>', at))
    const head = block.indexOf(selector + ' {')
    if (head === -1) throw new Error(`no ${selector} rule under reduced motion`)
    const body = block.slice(block.indexOf('{', head) + 1, block.indexOf('}', head))
    return new Map(
      body
        .split(';')
        .map((declaration) => declaration.split(':').map((part) => part.trim()))
        .filter(([name]) => name)
        .map(([name, value]) => [name!, value!])
    )
  }

  /*
   * The design lead's ruling (ATOMS-QUESTIONS-2, question 1): with the pulse stopped, a marker
   * that needs you keeps a steady halo, the prototype motion.css override ported as it is. The
   * stop itself lives in design-tokens.css; the halo sits here because the halo's scoped
   * `opacity: 0` outranks any unscoped rule.
   */
  it('holds a steady halo once the pulse stops, rather than no halo at all', () => {
    const halo = reducedRule('.dm-marker__pulse')
    expect(halo.get('opacity')).toBe('0.45')
    expect(halo.get('transform')).toBe('scale(1.15)')
  })

  it('declares the steady halo after the pulse it replaces, so it wins in source order', () => {
    expect(markerSource.indexOf(REDUCED)).toBeGreaterThan(
      markerSource.indexOf('animation: dm-pulse')
    )
  })
})

/*
 * APPENDED for #635 (PANEL-QUESTIONS 12, design lead ruling 2026-09-27): every marker, not only one
 * that needs you, sets `--delay` once when it is built, and its pulse starts that far into its loop.
 */
describe('TierMarker pulse phase (#635)', () => {
  it('sets --delay once at build to an offset within one pulse, on every marker', async () => {
    for (const asking of [false, true]) {
      const marker = mount(TierMarker, { props: { tier: 'gold', asking } })
      const delay = (marker.element as HTMLElement).style.getPropertyValue('--delay')
      expect(delay).toMatch(/^-?\d+ms$/)
      expect(Number.parseInt(delay, 10)).toBeLessThanOrEqual(0)
      expect(Number.parseInt(delay, 10)).toBeGreaterThanOrEqual(-1600)
      await marker.setProps({ selected: true, asking: !asking })
      expect((marker.element as HTMLElement).style.getPropertyValue('--delay')).toBe(delay)
    }
  })

  it('starts the pulse that far into its loop', () => {
    const style = markerSource
      .slice(markerSource.indexOf('<style'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const pulse = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((rule) => rule[1]!.trim() === '.dm-marker__pulse')
      .map((rule) => rule[2]!)
    expect(pulse.some((body) => body.includes('animation-delay: var(--delay, 0ms);'))).toBe(true)
  })
})
