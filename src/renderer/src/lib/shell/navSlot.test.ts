import { describe, expect, it } from 'vitest'
import { navSlotAttributes, navSlotClasses, navSlotName } from './navSlot'

describe('navSlotClasses', () => {
  it('is the slot and its recipe, then the forced state', () => {
    expect(navSlotClasses({ icon: 'map', label: 'Map' })).toEqual(['dm-slot', 'm-mat'])
    for (const state of ['hover', 'active', 'focus'] as const) {
      expect(navSlotClasses({ icon: 'map', label: 'Map', state })).toEqual([
        'dm-slot',
        'm-mat',
        'is-' + state
      ])
    }
  })
})

describe('navSlotName', () => {
  it('is the label, carrying the needs-you count the badge only shows', () => {
    expect(navSlotName('Mines')).toBe('Mines')
    expect(navSlotName('Mines', 0)).toBe('Mines')
    expect(navSlotName('Mines', 1)).toBe('Mines, 1 needs you')
    expect(navSlotName('Mines', 12)).toBe('Mines, 12 need you')
  })

  it('names the full count even where the badge overflows', () => {
    expect(navSlotName('Mines', 140)).toBe('Mines, 140 need you')
  })
})

describe('navSlotAttributes', () => {
  it('is a button named by its label, the label also the text that rises beside it', () => {
    expect(navSlotAttributes({ icon: 'map', label: 'Map' })).toEqual({
      type: 'button',
      'aria-label': 'Map',
      'data-label': 'Map'
    })
  })

  it('marks the page shown, a toggle and a warning', () => {
    expect(navSlotAttributes({ icon: 'mines', label: 'Mines', current: true })).toMatchObject({
      'aria-current': 'page'
    })
    expect(
      navSlotAttributes({ icon: 'music-off', label: 'Music', pressed: false })['aria-pressed']
    ).toBe('false')
    expect(
      navSlotAttributes({ icon: 'music-on', label: 'Music', pressed: true })['aria-pressed']
    ).toBe('true')
    expect(navSlotAttributes({ icon: 'settings', label: 'Settings', warn: true })).toMatchObject({
      'data-warn': 'true'
    })
  })

  it('states nothing it is not: no aria-current, aria-pressed or data-warn by default', () => {
    const attributes = navSlotAttributes({ icon: 'map', label: 'Map', current: false, warn: false })
    expect(attributes).not.toHaveProperty('aria-current')
    expect(attributes).not.toHaveProperty('aria-pressed')
    expect(attributes).not.toHaveProperty('data-warn')
  })

  it('carries the badge count in its name', () => {
    expect(navSlotAttributes({ icon: 'mines', label: 'Mines', badge: 2 })['aria-label']).toBe(
      'Mines, 2 need you'
    )
  })
})
