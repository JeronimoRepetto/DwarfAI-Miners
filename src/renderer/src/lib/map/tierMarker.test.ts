import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MARKER_PULSE_MS,
  markerPulseDelay,
  tierMarkerAttributes,
  tierMarkerClasses
} from './tierMarker'

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

/*
 * APPENDED for #635 (PANEL-QUESTIONS 12, design lead ruling 2026-09-27): each marker starts its
 * pulse at its own phase, a random negative offset within one pulse set once when it is built, as
 * each sprite starts on a random frame. The capture seeds Math.random and holds every loop at its
 * first keyframe with its delay at 0, so the goldens do not move for it.
 */
describe('markerPulseDelay', () => {
  it('is a whole negative offset within one pulse', () => {
    expect(markerPulseDelay(() => 0)).toBe('0ms')
    expect(markerPulseDelay(() => 0.5)).toBe('-800ms')
    expect(markerPulseDelay(() => 0.99999)).toBe('-1600ms')
  })

  it('spans one --dur-pulse, as design-tokens.css declares it', () => {
    const css = readFileSync(join(import.meta.dirname, '../../assets/design-tokens.css'), 'utf8')
    expect(/--dur-pulse:\s*(\d+)ms/.exec(css)?.[1]).toBe(String(MARKER_PULSE_MS))
  })
})
