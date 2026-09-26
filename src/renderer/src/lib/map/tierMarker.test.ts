import { describe, expect, it } from 'vitest'
import { tierMarkerAttributes, tierMarkerClasses } from './tierMarker'

describe('tierMarkerClasses', () => {
  it('is the marker, then the needs-you look, then the forced state', () => {
    expect(tierMarkerClasses({ tier: 'bronze' })).toEqual(['dm-marker'])
    expect(tierMarkerClasses({ tier: 'silver', asking: true })).toEqual([
      'dm-marker',
      'dm-marker--ask'
    ])
    for (const state of ['hover', 'active', 'focus'] as const) {
      expect(tierMarkerClasses({ tier: 'silver', state })).toEqual(['dm-marker', 'is-' + state])
    }
  })
})

describe('tierMarkerAttributes', () => {
  it('is a button carrying its tier, named "<Tier> mine" unless it is given a label', () => {
    expect(tierMarkerAttributes({ tier: 'copper' })).toEqual({
      type: 'button',
      'data-tier': 'copper',
      'aria-label': 'Copper mine'
    })
    expect(
      tierMarkerAttributes({ tier: 'gold', label: 'AI-Tools, Gold, needs you' })['aria-label']
    ).toBe('AI-Tools, Gold, needs you')
  })

  it('is pressed while its mine is open, and says nothing of it otherwise', () => {
    expect(tierMarkerAttributes({ tier: 'silver', selected: true })['aria-pressed']).toBe('true')
    expect(tierMarkerAttributes({ tier: 'silver', selected: false })).not.toHaveProperty(
      'aria-pressed'
    )
  })
})
