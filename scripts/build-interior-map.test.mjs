import { describe, expect, it } from 'vitest'
import { facingFromRoute, stationFacing } from './build-interior-map.mjs'

/**
 * Which way a dwarf faces, decided where the map is BUILT (#153).
 *
 * The maintainer's ruling: a dwarf faces the WALL it is picking — sometimes
 * left, sometimes right, depending on which rock its station works. The rule
 * that shipped was `facesLeft = x > 50`, "face the middle of the shaft", and it
 * was a coincidence: it happens to be right for five of the eighteen worker
 * stations and wrong for the other thirteen.
 *
 * What replaces it has two layers, and this file pins both. The DEFAULT is
 * derived from the corridor network the extraction already carries — a station
 * sits beside a corridor and turns away from it, into the rock. The OVERRIDE is
 * the maintainer's own authored sheet, and it wins outright, because an arrow
 * drawn on the art is evidence and a derivation is an inference.
 *
 * Both live in the generator rather than in the renderer, so facing is DATA in
 * the committed map and is never re-derived at render time.
 */

/** A corridor running straight down the painting at a given x. */
function verticalCorridor(x, fromY, toY) {
  return [
    {
      points: [
        { x, y: fromY },
        { x, y: toY }
      ]
    }
  ]
}

describe('facingFromRoute', () => {
  it('turns a station on the corridor’s left away from it, into the left rock', () => {
    const edges = verticalCorridor(60, 10, 90)
    expect(facingFromRoute({ x: 45, y: 50 }, edges)).toBe(true)
  })

  it('turns a station on the corridor’s right away from it, into the right rock', () => {
    const edges = verticalCorridor(60, 10, 90)
    expect(facingFromRoute({ x: 75, y: 50 }, edges)).toBe(false)
  })

  /*
   * The old rule read the station's own x against the middle of the painting,
   * which is why it was wrong so often: a station at x 48 can perfectly well be
   * working the rock to its LEFT, and this is that case.
   */
  it('reads the corridor beside the station, not the middle of the painting', () => {
    const edges = verticalCorridor(70, 10, 90)
    expect(facingFromRoute({ x: 48, y: 50 }, edges)).toBe(true)
    expect({ x: 48 }.x > 50).toBe(false)
  })

  it('measures in painting pixels, so a tall drop is not mistaken for a near corridor', () => {
    // The art is three times taller than it is wide, so a corridor 20 percent
    // BELOW is far further away than one 12 percent to the side — in percent
    // space the far one wins and the station faces the wrong wall.
    const edges = [
      ...verticalCorridor(30, 48, 52),
      {
        points: [
          { x: 0, y: 70 },
          { x: 100, y: 70 }
        ]
      }
    ]
    expect(facingFromRoute({ x: 42, y: 50 }, edges)).toBe(false)
  })

  it('reads the nearest corridor when several run past the station', () => {
    const edges = [...verticalCorridor(10, 20, 80), ...verticalCorridor(70, 20, 80)]
    // Fifteen percent of the width away on the right, forty-five on the left:
    // the near one decides, and it puts the rock on this dwarf's left.
    expect(facingFromRoute({ x: 55, y: 50 }, edges)).toBe(true)
  })

  it('attaches part-way along a corridor rather than only at its corners', () => {
    // A station beside the long side of a gallery reads that side, not the
    // corner it happens to be closest to along the polyline.
    const edges = [
      {
        points: [
          { x: 5, y: 20 },
          { x: 60, y: 20 },
          { x: 60, y: 80 },
          { x: 5, y: 80 }
        ]
      }
    ]
    expect(facingFromRoute({ x: 50, y: 50 }, edges)).toBe(true)
  })

  it('falls back to the shaft’s middle for a station standing on the corridor', () => {
    // Nothing to turn away from: the corridor is directly underfoot, so there is
    // no side to read and the old rule is as good an answer as exists.
    const edges = [
      {
        points: [
          { x: 0, y: 50 },
          { x: 100, y: 50 }
        ]
      }
    ]
    expect(facingFromRoute({ x: 70, y: 50 }, edges)).toBe(true)
    expect(facingFromRoute({ x: 30, y: 50 }, edges)).toBe(false)
  })
})

describe('stationFacing', () => {
  const edges = verticalCorridor(60, 10, 90)
  const station = { id: 'worker-1', x: 45, y: 50 }

  it('takes the authored facing over the derivation, in both directions', () => {
    expect(stationFacing(station, edges, { 'worker-1': 'right' })).toBe(false)
    expect(stationFacing({ ...station, x: 75 }, edges, { 'worker-1': 'left' })).toBe(true)
  })

  it('derives the facing for a station the sheet does not author', () => {
    expect(stationFacing(station, edges, {})).toBe(facingFromRoute(station, edges))
    expect(stationFacing(station, edges, { 'worker-9': 'right' })).toBe(true)
  })

  it('refuses a facing it cannot read, rather than guessing which way it meant', () => {
    // A typo in the authored sheet must stop the build, not silently become a
    // derivation — the whole point of the override is that it is not inferred.
    expect(() => stationFacing(station, edges, { 'worker-1': 'LEFT ' })).toThrow(/worker-1/)
    expect(() => stationFacing(station, edges, { 'worker-1': true })).toThrow(/worker-1/)
  })
})
