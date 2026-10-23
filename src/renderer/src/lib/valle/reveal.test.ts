import { describe, expect, it } from 'vitest'
import { zoneScrollLeft } from './reveal'

/*
 * Where the Control room's mosaic scrolls to bring a zone into view (07 S39.06, S32.14; ADR-025 item 8): as little as it
 * can, over a viewport 600 px wide.
 */
const viewport = (scrollLeft: number) => ({ scrollLeft, width: 600 })

describe('the scroll that brings a Valle zone into view (ISSUE-311)', () => {
  it('[S39.06, S32.14] a zone in view moves nothing; one to the left or right lines its near edge up with the viewport', () => {
    // Wholly in view, edges included.
    expect(zoneScrollLeft(viewport(300), { left: 300, width: 300 })).toBeNull()
    expect(zoneScrollLeft(viewport(300), { left: 600, width: 300 })).toBeNull()
    // Past the right edge: its right edge lines up with the viewport's.
    expect(zoneScrollLeft(viewport(0), { left: 600, width: 300 })).toBe(300)
    expect(zoneScrollLeft(viewport(0), { left: 450, width: 300 })).toBe(150)
    // Before the left edge: its left edge lines up with the viewport's.
    expect(zoneScrollLeft(viewport(900), { left: 300, width: 300 })).toBe(300)
    expect(zoneScrollLeft(viewport(400), { left: 300, width: 300 })).toBe(300)
  })

  it('[S39.06] a zone wider than the viewport shows its left edge, and the scroll never goes below zero', () => {
    expect(zoneScrollLeft(viewport(0), { left: 700, width: 900 })).toBe(700)
    expect(zoneScrollLeft(viewport(50), { left: -20, width: 100 })).toBe(0)
  })
})
