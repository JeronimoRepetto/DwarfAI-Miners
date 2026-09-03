import { describe, expect, it } from 'vitest'
import {
  INTERIOR_PAINTING_SIZE,
  INTERIOR_ROUTE_EDGES,
  INTERIOR_ROUTE_NODES,
  INTERIOR_STATIONS,
  type InteriorPoint
} from './interiorMap'
import {
  INTERIOR_ROUTE,
  buildRouteGraph,
  nearestOnRoute,
  paintingDistance,
  polylineLength,
  routeBetween
} from './interiorRoute'

/** How far the nearest corridor is from a point, in painting pixels. */
function distanceToNetwork(point: InteriorPoint): number {
  return nearestOnRoute(INTERIOR_ROUTE, point).distance
}

const stationsOf = (kind: string): readonly InteriorPoint[] =>
  INTERIOR_STATIONS.filter((station) => station.kind === kind)

describe('paintingDistance', () => {
  /*
   * The painting is three times taller than it is wide, so percent-space
   * distance is not a distance at all: one percent of height is three times one
   * percent of width. Everything downstream — which corridor is nearest, which
   * route is shortest, how long a walk takes — is wrong in the same direction
   * if this is measured naively.
   */
  it('weights a vertical percent by the height it actually spans', () => {
    const across = paintingDistance({ x: 0, y: 50 }, { x: 10, y: 50 })
    const down = paintingDistance({ x: 50, y: 0 }, { x: 50, y: 10 })
    expect(across).toBeCloseTo(0.1 * INTERIOR_PAINTING_SIZE.width)
    expect(down).toBeCloseTo(0.1 * INTERIOR_PAINTING_SIZE.height)
    expect(down / across).toBeCloseTo(INTERIOR_PAINTING_SIZE.height / INTERIOR_PAINTING_SIZE.width)
  })
})

describe('polylineLength', () => {
  it('adds up the segments rather than measuring end to end', () => {
    const dogleg = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0.5 }
    ]
    expect(polylineLength(dogleg)).toBeCloseTo(
      0.1 * INTERIOR_PAINTING_SIZE.width + 0.005 * INTERIOR_PAINTING_SIZE.height
    )
    expect(polylineLength(dogleg)).toBeGreaterThan(paintingDistance(dogleg[0]!, dogleg[2]!))
  })

  it('is zero for a polyline with nowhere to go', () => {
    expect(polylineLength([])).toBe(0)
    expect(polylineLength([{ x: 5, y: 5 }])).toBe(0)
  })
})

describe('nearestOnRoute', () => {
  it('lands on the corridor rather than on the nearest junction', () => {
    // The midpoint of a long corridor's first segment: a junction-only search
    // would answer with one of its ends instead.
    const edge = INTERIOR_ROUTE_EDGES[0]!
    const midpoint = {
      x: (edge.points[0]!.x + edge.points[1]!.x) / 2,
      y: (edge.points[0]!.y + edge.points[1]!.y) / 2
    }
    const found = nearestOnRoute(INTERIOR_ROUTE, midpoint)
    expect(found.distance).toBeCloseTo(0)
    expect(found.point.x).toBeCloseTo(midpoint.x)
    expect(found.point.y).toBeCloseTo(midpoint.y)
  })

  /*
   * A junction is not exactly on its own corridors: node positions come out of
   * the extraction's merge clustering, whose radius is 6 source pixels
   * (docs/map-coordinates.md §6), while the polylines keep their raw points.
   *
   * The bound is that documented radius, converted: one source pixel of the
   * 179px-wide panel is 6.6 pixels of the 1184px-wide painting, so 6 of them is
   * about 40 — which is 8 screen pixels at the design's 245px column, and the
   * same tolerance the generator's own endpoint check uses. Stating it in the
   * wrong unit is the easy mistake here, and it is a factor of six.
   */
  it('reports a junction it is handed as being on the network', () => {
    for (const node of INTERIOR_ROUTE_NODES) {
      expect(distanceToNetwork(node), `${node.id}`).toBeLessThan(40)
    }
  })

  it('measures how far along its corridor the attachment sits, from both ends', () => {
    const edge = INTERIOR_ROUTE_EDGES[0]!
    const found = nearestOnRoute(INTERIOR_ROUTE, edge.points[1]!)
    const total = polylineLength(edge.points)
    expect(found.toFrom + found.toTo).toBeCloseTo(total)
  })
})

describe('routeBetween', () => {
  const spawn = stationsOf('spawn')[0]!
  const far = stationsOf('worker')[0]!

  it('starts where it was asked to start and ends where it was asked to end', () => {
    const path = routeBetween(INTERIOR_ROUTE, spawn, far)
    expect(path[0]).toEqual(spawn)
    expect(path[path.length - 1]).toEqual(far)
  })

  /*
   * The whole reason a route network exists rather than a straight line: a
   * dwarf walking from the entrance to a ceiling gallery has to follow the
   * painted stairs and ladders, not cut diagonally through 3000 pixels of rock.
   * Every point between the two ends has to sit on a corridor.
   */
  it('keeps every step between the two ends on a painted corridor', () => {
    for (const station of stationsOf('worker')) {
      const path = routeBetween(INTERIOR_ROUTE, spawn, station)
      for (const point of path.slice(1, -1)) {
        expect(distanceToNetwork(point), `${station.x},${station.y}`).toBeLessThan(1)
      }
    }
  })

  it('never walks further than a straight line would have to be wrong', () => {
    for (const station of [...stationsOf('worker'), ...stationsOf('foreman')]) {
      const path = routeBetween(INTERIOR_ROUTE, spawn, station)
      const walked = polylineLength(path)
      const asTheCrowFlies = paintingDistance(spawn, station)
      expect(walked, `${station.x},${station.y}`).toBeGreaterThanOrEqual(asTheCrowFlies - 1)
      // A route that wanders is a bug too: nothing in one mine justifies more
      // than four times the direct distance.
      expect(walked, `${station.x},${station.y}`).toBeLessThan(asTheCrowFlies * 4 + 500)
    }
  })

  it('reaches every station from every spawn, which is what the stub splice bought', () => {
    for (const from of stationsOf('spawn')) {
      for (const to of [...stationsOf('worker'), ...stationsOf('foreman')]) {
        const path = routeBetween(INTERIOR_ROUTE, from, to)
        expect(path.length).toBeGreaterThanOrEqual(2)
        expect(Number.isFinite(polylineLength(path))).toBe(true)
      }
    }
  })

  it('stays on one corridor when both ends attach to the same one', () => {
    const edge = INTERIOR_ROUTE_EDGES[0]!
    const path = routeBetween(INTERIOR_ROUTE, edge.points[0]!, edge.points[1]!)
    expect(polylineLength(path)).toBeCloseTo(paintingDistance(edge.points[0]!, edge.points[1]!))
  })

  it('answers a journey to nowhere with the point it was given', () => {
    const path = routeBetween(INTERIOR_ROUTE, spawn, spawn)
    expect(polylineLength(path)).toBeLessThan(1)
    expect(path[path.length - 1]).toEqual(spawn)
  })

  it('walks the same route backwards when the ends are swapped', () => {
    const there = routeBetween(INTERIOR_ROUTE, spawn, far)
    const back = routeBetween(INTERIOR_ROUTE, far, spawn)
    expect(polylineLength(back)).toBeCloseTo(polylineLength(there))
  })
})

describe('buildRouteGraph', () => {
  it('refuses a corridor that names a junction it does not have', () => {
    expect(() =>
      buildRouteGraph(
        [{ id: 0, x: 0, y: 0 }],
        [
          {
            from: 0,
            to: 9,
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1 }
            ]
          }
        ]
      )
    ).toThrow(/9/)
  })

  it('carries the committed map, so the scene never builds its own', () => {
    expect(INTERIOR_ROUTE.nodes).toEqual(INTERIOR_ROUTE_NODES)
    expect(INTERIOR_ROUTE.edges).toEqual(INTERIOR_ROUTE_EDGES)
  })
})
