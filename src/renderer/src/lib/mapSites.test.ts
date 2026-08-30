import { describe, expect, it } from 'vitest'
import { MAP_TRAILS, MINE_SITES, VALLEY_HUB, moundLinkClass, trailPoints } from './mapSites'

/**
 * The painting is rendered with `object-fit: cover; object-position: 50% 60%`,
 * so a panel narrower or wider than the painting crops the edges. Sites must
 * stay inside this central band to survive typical panel aspect ratios.
 */
const SAFE_BOUNDS = { xMin: 18, xMax: 82, yMin: 24, yMax: 76 }

/** Mounds paint ~116px wide; closer than this and two sites read as one blob. */
const MIN_SITE_DISTANCE = 12

function pointKey(point: { x: number; y: number }): string {
  return `${point.x},${point.y}`
}

describe('MINE_SITES', () => {
  it('authors at least 12 sites so slot assignment keeps its collision-free range', () => {
    expect(MINE_SITES.length).toBeGreaterThanOrEqual(12)
  })

  it('gives every site a distinct name', () => {
    const names = MINE_SITES.map((site) => site.name)
    expect(new Set(names).size).toBe(MINE_SITES.length)
  })

  it('keeps every site inside the safe central band of the cover-cropped painting', () => {
    for (const site of MINE_SITES) {
      expect(site.x, site.name).toBeGreaterThanOrEqual(SAFE_BOUNDS.xMin)
      expect(site.x, site.name).toBeLessThanOrEqual(SAFE_BOUNDS.xMax)
      expect(site.y, site.name).toBeGreaterThanOrEqual(SAFE_BOUNDS.yMin)
      expect(site.y, site.name).toBeLessThanOrEqual(SAFE_BOUNDS.yMax)
    }
  })

  it('keeps every pair of sites at least a mound apart', () => {
    for (const [index, site] of MINE_SITES.entries()) {
      for (const other of MINE_SITES.slice(index + 1)) {
        const distance = Math.hypot(site.x - other.x, site.y - other.y)
        expect(distance, `${site.name} vs ${other.name}`).toBeGreaterThanOrEqual(MIN_SITE_DISTANCE)
      }
    }
  })

  it('orders sites far to near (y ascending) so painting in order keeps isometric depth', () => {
    const ys = MINE_SITES.map((site) => site.y)
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
  })

  it('grows the depth scale hint gently toward the foreground', () => {
    const scales = MINE_SITES.map((site) => site.scale ?? 1)
    expect(scales).toEqual([...scales].sort((a, b) => a - b))
    for (const scale of scales) {
      expect(scale).toBeGreaterThanOrEqual(0.8)
      expect(scale).toBeLessThanOrEqual(1.15)
    }
  })
})

describe('MAP_TRAILS', () => {
  it('draws each trail with at least two points inside the box', () => {
    for (const trail of MAP_TRAILS) {
      expect(trail.length).toBeGreaterThanOrEqual(2)
      for (const point of trail) {
        expect(point.x).toBeGreaterThanOrEqual(0)
        expect(point.x).toBeLessThanOrEqual(100)
        expect(point.y).toBeGreaterThanOrEqual(0)
        expect(point.y).toBeLessThanOrEqual(100)
      }
    }
  })

  it('touches every site with a trail', () => {
    const touched = new Set(MAP_TRAILS.flatMap((trail) => trail.map(pointKey)))
    for (const site of MINE_SITES) {
      expect(touched.has(pointKey(site)), site.name).toBe(true)
    }
  })

  it('connects every site to the valley hub, so the map reads as one place', () => {
    const adjacency = new Map<string, string[]>()
    const link = (a: string, b: string): void => {
      adjacency.set(a, [...(adjacency.get(a) ?? []), b])
      adjacency.set(b, [...(adjacency.get(b) ?? []), a])
    }
    for (const trail of MAP_TRAILS) {
      let previous: { x: number; y: number } | undefined
      for (const point of trail) {
        if (previous) link(pointKey(previous), pointKey(point))
        previous = point
      }
    }
    const queue = [pointKey(VALLEY_HUB)]
    const reachable = new Set(queue)
    while (queue.length > 0) {
      const current = queue.pop()
      if (current === undefined) break
      for (const next of adjacency.get(current) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next)
          queue.push(next)
        }
      }
    }
    for (const site of MINE_SITES) {
      expect(reachable.has(pointKey(site)), site.name).toBe(true)
    }
  })
})

describe('trailPoints', () => {
  it('serializes a trail into SVG polyline points', () => {
    expect(
      trailPoints([
        { x: 19, y: 27 },
        { x: 17.5, y: 34 }
      ])
    ).toBe('19,27 17.5,34')
  })
})

describe('moundLinkClass', () => {
  it('lights nothing while no mound is hot', () => {
    expect(moundLinkClass('C:/dev/alpha', null)).toBe('')
  })

  it('marks the hot mound and dims every other one', () => {
    expect(moundLinkClass('C:/dev/alpha', 'C:/dev/alpha')).toBe('is-hot')
    expect(moundLinkClass('C:/dev/beta', 'C:/dev/alpha')).toBe('is-dim')
  })
})
