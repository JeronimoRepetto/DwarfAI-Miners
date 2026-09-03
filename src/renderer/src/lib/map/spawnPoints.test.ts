import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAP_SPAWN_POINTS } from './spawnPoints.generated'

/**
 * The design fixes the count outright — "the map defines **74** symmetric spawn
 * locations" — and the extraction found exactly 74 (docs/map-coordinates.md
 * §2). A generated file cannot be reviewed line by line, so what is checked
 * here is everything about it that has a right answer: how many, that no two
 * mines can be told apart only by an array position, that nothing landed off
 * the painting, and that the committed numbers are still the ones the recorded
 * conversion produces.
 */
describe('MAP_SPAWN_POINTS', () => {
  it('carries the 74 spawn locations the design defines', () => {
    expect(MAP_SPAWN_POINTS).toHaveLength(74)
  })

  it('gives every point a unique id, since the id is what gets persisted', () => {
    const ids = MAP_SPAWN_POINTS.map((point) => point.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort((a, b) => a - b)).toEqual(
      Array.from({ length: MAP_SPAWN_POINTS.length }, (_, index) => index + 1)
    )
  })

  it('keeps every point on the painting', () => {
    for (const point of MAP_SPAWN_POINTS) {
      expect(point.x, `site ${point.id} x`).toBeGreaterThanOrEqual(0)
      expect(point.x, `site ${point.id} x`).toBeLessThanOrEqual(100)
      expect(point.y, `site ${point.id} y`).toBeGreaterThanOrEqual(0)
      expect(point.y, `site ${point.id} y`).toBeLessThanOrEqual(100)
    }
  })

  /*
    Ordered down the painting, which is the drawing order: a nearer marker
    paints over a farther one. Not an identity — that is `id` — but a property
    the generator preserves from the extraction and one a hand-edit would break.
  */
  it('is ordered down the painting, farthest first', () => {
    const ys = MAP_SPAWN_POINTS.map((point) => point.y)
    expect([...ys].sort((a, b) => a - b)).toEqual(ys)
  })

  /*
    Two markers closer than a marker's own width read as one blob, and worse,
    as two mines a click cannot separate. The measured minimum across this set
    is 2.65 percent (sites 22 and 23), so this floor has room under it rather
    than being a fit to the data.
  */
  it('never puts two sites close enough to read as one marker', () => {
    let closest = Infinity
    for (const [index, point] of MAP_SPAWN_POINTS.entries()) {
      for (const other of MAP_SPAWN_POINTS.slice(index + 1)) {
        closest = Math.min(closest, Math.hypot(point.x - other.x, point.y - other.y))
      }
    }
    expect(closest).toBeGreaterThan(2)
  })

  /**
   * The committed data against its source, so a stale generated file cannot
   * ride along unnoticed.
   *
   * The two constants here are a MEASUREMENT — the artwork's rectangle inside
   * the design's mockup screenshot, reported by
   * `scripts/extract-map-markers.mjs` — repeated deliberately rather than
   * imported. The point of the check is that the committed numbers came from
   * exactly this re-anchoring: reading the rect out of the generator would make
   * the test agree with whatever the generator currently believes, which is the
   * one thing it must not do.
   */
  it('is the recorded re-anchoring of the measured spawn points', () => {
    const source = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../../../docs/map-spawn-points.json'), 'utf8')
    ) as { spawnPoints: { id: number; pixel: { x: number; y: number } }[] }

    /* Artwork interior of the 645x772 mockup: x 25..608, y 19..743, as edges. */
    const artwork = { left: 24.5, top: 18.5, width: 584, height: 725 }
    const round2 = (value: number): number => Math.round(value * 100) / 100

    expect(source.spawnPoints).toHaveLength(MAP_SPAWN_POINTS.length)
    for (const [index, measured] of source.spawnPoints.entries()) {
      expect(MAP_SPAWN_POINTS[index]).toEqual({
        id: measured.id,
        x: round2(((measured.pixel.x + 0.5 - artwork.left) / artwork.width) * 100),
        y: round2(((measured.pixel.y + 0.5 - artwork.top) / artwork.height) * 100)
      })
    }
  })
})
