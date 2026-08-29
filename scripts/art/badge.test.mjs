import { describe, expect, it } from 'vitest'
import { badgeAlpha, badgeColor, centerOffset, lerp, scaleToWidth, smoothstep } from './badge.mjs'

describe('lerp', () => {
  it('returns a at t=0 and b at t=1', () => {
    expect(lerp(10, 20, 0)).toBe(10)
    expect(lerp(10, 20, 1)).toBe(20)
  })

  it('interpolates linearly in between', () => {
    expect(lerp(0, 100, 0.25)).toBe(25)
  })
})

describe('smoothstep', () => {
  it('is 0 at or below edge0 and 1 at or above edge1', () => {
    expect(smoothstep(10, 20, 5)).toBe(0)
    expect(smoothstep(10, 20, 10)).toBe(0)
    expect(smoothstep(10, 20, 20)).toBe(1)
    expect(smoothstep(10, 20, 30)).toBe(1)
  })

  it('is 0.5 at the midpoint', () => {
    expect(smoothstep(0, 10, 5)).toBe(0.5)
  })

  it('treats a zero-width edge as a hard step', () => {
    expect(smoothstep(10, 10, 9)).toBe(0)
    expect(smoothstep(10, 10, 10)).toBe(1)
  })
})

describe('badgeAlpha', () => {
  it('is fully opaque well inside the radius', () => {
    expect(badgeAlpha(0, 100, 5)).toBe(255)
  })

  it('is fully transparent well outside the radius', () => {
    expect(badgeAlpha(200, 100, 5)).toBe(0)
  })

  it('feathers across the boundary instead of stepping', () => {
    const atEdge = badgeAlpha(100, 100, 10)
    expect(atEdge).toBeGreaterThan(0)
    expect(atEdge).toBeLessThan(255)
  })
})

describe('badgeColor', () => {
  const CENTER = [255, 200, 100]
  const EDGE = [10, 20, 30]

  it('is the center color at distance 0', () => {
    expect(badgeColor(0, 100, CENTER, EDGE)).toEqual(CENTER)
  })

  it('is the edge color at or past the radius', () => {
    expect(badgeColor(100, 100, CENTER, EDGE)).toEqual(EDGE)
    expect(badgeColor(500, 100, CENTER, EDGE)).toEqual(EDGE)
  })

  it('blends between the two halfway out', () => {
    expect(badgeColor(50, 100, CENTER, EDGE)).toEqual([
      Math.round((255 + 10) / 2),
      Math.round((200 + 20) / 2),
      Math.round((100 + 30) / 2)
    ])
  })
})

describe('centerOffset', () => {
  it('centers a smaller box inside a larger canvas', () => {
    expect(centerOffset(1024, 512)).toBe(256)
  })

  it('rounds an odd remainder consistently', () => {
    expect(centerOffset(101, 50)).toBe(26)
  })
})

describe('scaleToWidth', () => {
  it('preserves aspect ratio when scaling to a target width', () => {
    expect(scaleToWidth(512, 399, 1024)).toEqual({ width: 1024, height: 798 })
  })

  it('never returns a zero-sized dimension', () => {
    expect(scaleToWidth(1000, 1, 1)).toEqual({ width: 1, height: 1 })
  })
})
