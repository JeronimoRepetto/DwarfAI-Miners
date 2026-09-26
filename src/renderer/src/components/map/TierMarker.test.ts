// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TierMarker from './TierMarker.vue'

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
