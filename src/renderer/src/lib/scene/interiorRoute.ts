/**
 * Getting from one place in the mine to another along the painted corridors.
 *
 * `interiorMap.ts` says what the passable paths ARE — a graph of junctions and
 * the polylines between them, extracted from the design's own route overlay.
 * This turns that into the one question the scene asks: given a dwarf standing
 * somewhere and a workstation it has to reach, what is the line it walks?
 *
 * ## Why not a straight line
 *
 * The interior is a 1184 x 3622 tower of galleries stacked on each other, and
 * two points a short way apart on screen are routinely separated by a floor of
 * solid rock. A dwarf sent from the entrance to a ceiling gallery in a straight
 * line walks through six of them. The corridors, the stairs and the ladders are
 * painted, and a dwarf that ignores them is not in the mine.
 *
 * ## Ladders and ramps need no physics
 *
 * The design marks them as their own annotation classes, but the route overlay
 * already draws its gray line straight up every ladder and down every ramp — so
 * they arrive as ordinary stretches of polyline, and a dwarf climbing one is a
 * dwarf walking a steep segment. What that buys is that nothing here has a
 * special case: no mode switch, no climb animation to keep in sync, no way for
 * a ladder to be half-entered. What it costs is that a dwarf on a ladder walks
 * it at the same pace he walks a corridor, which at 245px wide reads as
 * climbing rather than as gliding.
 *
 * ## Distances are painting pixels, never percent
 *
 * Everything here measures in pixels of the painting, because the art is three
 * times taller than it is wide: in percent space a long vertical drop looks
 * "nearer" than a short sideways step, which would pick the wrong corridor, the
 * wrong route and the wrong walk duration, all consistently enough to look
 * deliberate.
 */
import {
  INTERIOR_PAINTING_SIZE,
  INTERIOR_ROUTE_EDGES,
  INTERIOR_ROUTE_NODES,
  type InteriorPoint,
  type RouteEdge,
  type RouteNode
} from './interiorMap'

/** How far apart two image-percent points are, in pixels of the painting. */
export function paintingDistance(a: InteriorPoint, b: InteriorPoint): number {
  return Math.hypot(
    ((a.x - b.x) / 100) * INTERIOR_PAINTING_SIZE.width,
    ((a.y - b.y) / 100) * INTERIOR_PAINTING_SIZE.height
  )
}

/** The walked length of a polyline, corner by corner rather than end to end. */
export function polylineLength(points: readonly InteriorPoint[]): number {
  let total = 0
  for (let index = 1; index < points.length; index++) {
    total += paintingDistance(points[index - 1] as InteriorPoint, points[index] as InteriorPoint)
  }
  return total
}

/** The route network, with the adjacency and lengths a search needs. */
export interface RouteGraph {
  nodes: readonly RouteNode[]
  edges: readonly RouteEdge[]
  /** Corridor indices reachable from each junction id. */
  adjacency: ReadonlyMap<number, readonly number[]>
  /** Walked length of each corridor, by the same index. */
  lengths: readonly number[]
}

/** Where a point off the network attaches to it. */
export interface RouteAttachment {
  /** Which corridor it attaches to. */
  edgeIndex: number
  /** The point on that corridor, in image percent. */
  point: InteriorPoint
  /** How far the point is from the corridor, in painting pixels. */
  distance: number
  /** Walked distance from the attachment back to the corridor's `from` end. */
  toFrom: number
  /** Walked distance from the attachment on to the corridor's `to` end. */
  toTo: number
  /** Which segment of the polyline it fell on, and how far along it. */
  segment: number
}

export function buildRouteGraph(
  nodes: readonly RouteNode[],
  edges: readonly RouteEdge[]
): RouteGraph {
  const ids = new Set(nodes.map((node) => node.id))
  const adjacency = new Map<number, number[]>()
  edges.forEach((edge, index) => {
    for (const id of [edge.from, edge.to]) {
      // A corridor to a junction that is not there would search forever or
      // silently drop half the mine; neither is a state to render around.
      if (!ids.has(id)) throw new Error(`route corridor ${index} names missing junction ${id}`)
      adjacency.set(id, [...(adjacency.get(id) ?? []), index])
    }
  })
  return { nodes, edges, adjacency, lengths: edges.map((edge) => polylineLength(edge.points)) }
}

/** The one network every mine shares, built once from the committed map. */
export const INTERIOR_ROUTE: RouteGraph = buildRouteGraph(
  INTERIOR_ROUTE_NODES,
  INTERIOR_ROUTE_EDGES
)

/** Where on the segment `a`-`b` the foot of the perpendicular from `p` falls, 0-1. */
function projectOntoSegment(p: InteriorPoint, a: InteriorPoint, b: InteriorPoint): number {
  // In painting pixels, so the projection is a real perpendicular rather than
  // one skewed by the art's 1:3 shape.
  const ax = (a.x / 100) * INTERIOR_PAINTING_SIZE.width
  const ay = (a.y / 100) * INTERIOR_PAINTING_SIZE.height
  const bx = (b.x / 100) * INTERIOR_PAINTING_SIZE.width
  const by = (b.y / 100) * INTERIOR_PAINTING_SIZE.height
  const px = (p.x / 100) * INTERIOR_PAINTING_SIZE.width
  const py = (p.y / 100) * INTERIOR_PAINTING_SIZE.height
  const dx = bx - ax
  const dy = by - ay
  const squared = dx * dx + dy * dy
  if (squared === 0) return 0
  return Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / squared, 0), 1)
}

function lerp(a: InteriorPoint, b: InteriorPoint, t: number): InteriorPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/**
 * The closest point on the whole network to `point`.
 *
 * Searches segments rather than junctions: a workstation halfway along a
 * gallery must join the corridor beside it, not walk to the stairs at its end
 * first and come back.
 */
export function nearestOnRoute(graph: RouteGraph, point: InteriorPoint): RouteAttachment {
  let best: RouteAttachment | undefined
  graph.edges.forEach((edge, edgeIndex) => {
    for (let segment = 0; segment + 1 < edge.points.length; segment++) {
      const a = edge.points[segment] as InteriorPoint
      const b = edge.points[segment + 1] as InteriorPoint
      const t = projectOntoSegment(point, a, b)
      const on = lerp(a, b, t)
      const distance = paintingDistance(point, on)
      if (best && distance >= best.distance) continue
      const toFrom = polylineLength(edge.points.slice(0, segment + 1)) + paintingDistance(a, on)
      best = {
        edgeIndex,
        point: on,
        distance,
        segment,
        toFrom,
        toTo: (graph.lengths[edgeIndex] as number) - toFrom
      }
    }
  })
  if (!best) throw new Error('the route network has no corridor to attach to')
  return best
}

/** A corridor's points, oriented so they run from `from` to `to`. */
function orientedPoints(edge: RouteEdge, from: number): readonly InteriorPoint[] {
  return edge.from === from ? edge.points : [...edge.points].reverse()
}

/** The attachment's own corridor, from the attachment to whichever end. */
function sliceFromAttachment(
  edge: RouteEdge,
  attachment: RouteAttachment,
  towards: 'from' | 'to'
): readonly InteriorPoint[] {
  const points = edge.points
  return towards === 'to'
    ? [attachment.point, ...points.slice(attachment.segment + 1)]
    : [attachment.point, ...points.slice(0, attachment.segment + 1).reverse()]
}

/** Shortest walked distance from one junction to every other, and how it got there. */
function shortestPaths(
  graph: RouteGraph,
  start: number
): { cost: Map<number, number>; via: Map<number, number> } {
  const cost = new Map<number, number>([[start, 0]])
  const via = new Map<number, number>()
  const settled = new Set<number>()
  // 20 junctions: a scan for the cheapest unsettled node is both the simplest
  // correct thing and faster than any heap would be at this size.
  for (;;) {
    let next: number | undefined
    let best = Infinity
    for (const [id, value] of cost) {
      if (settled.has(id) || value >= best) continue
      next = id
      best = value
    }
    if (next === undefined) return { cost, via }
    settled.add(next)
    for (const edgeIndex of graph.adjacency.get(next) ?? []) {
      const edge = graph.edges[edgeIndex] as RouteEdge
      const other = edge.from === next ? edge.to : edge.from
      const through = best + (graph.lengths[edgeIndex] as number)
      if (through >= (cost.get(other) ?? Infinity)) continue
      cost.set(other, through)
      via.set(other, edgeIndex)
    }
  }
}

/** The corridor polylines along the cheapest way from `start` to `end`. */
function walkNodes(
  graph: RouteGraph,
  start: number,
  end: number,
  via: ReadonlyMap<number, number>
): readonly InteriorPoint[] {
  const legs: InteriorPoint[][] = []
  let node = end
  while (node !== start) {
    const edgeIndex = via.get(node)
    if (edgeIndex === undefined) return []
    const edge = graph.edges[edgeIndex] as RouteEdge
    const previous = edge.from === node ? edge.to : edge.from
    legs.unshift([...orientedPoints(edge, previous)])
    node = previous
  }
  return legs.flat()
}

/** Drop a point that repeats the one before it, to within a pixel of painting. */
function dedupe(points: readonly InteriorPoint[]): readonly InteriorPoint[] {
  const out: InteriorPoint[] = []
  for (const point of points) {
    const last = out[out.length - 1]
    if (last && paintingDistance(last, point) < 1) continue
    out.push(point)
  }
  return out
}

/**
 * The line a dwarf walks from `from` to `to`.
 *
 * Always starts exactly at `from` and ends exactly at `to` — the two ends are
 * where a dwarf actually stands, which is beside a corridor and not on it — with
 * the painted route in between. Both ends attach to the network at their nearest
 * point, and the search then compares every way round: the two ends of the
 * starting corridor against the two ends of the finishing one, so a dwarf never
 * walks to the top of a stair he was standing next to the bottom of.
 */
export function routeBetween(
  graph: RouteGraph,
  from: InteriorPoint,
  to: InteriorPoint
): readonly InteriorPoint[] {
  const start = nearestOnRoute(graph, from)
  const finish = nearestOnRoute(graph, to)
  /*
   * Two places closer to each other than either is to the network at all: the
   * corridor cannot be a shortcut between them, so joining it and coming back
   * is a detour by construction. Above all this is what stops a dwarf whose
   * target has not moved from stepping out to the stairs and back again on
   * every poll.
   */
  if (paintingDistance(from, to) <= start.distance + finish.distance) return dedupe([from, to])

  const startEdge = graph.edges[start.edgeIndex] as RouteEdge
  const finishEdge = graph.edges[finish.edgeIndex] as RouteEdge

  if (start.edgeIndex === finish.edgeIndex) {
    // Both beside the same corridor: walk the stretch between them and no more.
    const forward = start.toFrom <= finish.toFrom
    const [first, second] = forward ? [start, finish] : [finish, start]
    const between = startEdge.points.slice(first.segment + 1, second.segment + 1)
    const along = [start.point, ...(forward ? between : [...between].reverse()), finish.point]
    return dedupe([from, ...along, to])
  }

  const ends = ['from', 'to'] as const
  let best: readonly InteriorPoint[] | undefined
  let bestCost = Infinity
  for (const startEnd of ends) {
    const startNode = startEnd === 'from' ? startEdge.from : startEdge.to
    const { cost, via } = shortestPaths(graph, startNode)
    for (const finishEnd of ends) {
      const finishNode = finishEnd === 'from' ? finishEdge.from : finishEdge.to
      const between = cost.get(finishNode)
      if (between === undefined) continue
      const total =
        (startEnd === 'from' ? start.toFrom : start.toTo) +
        between +
        (finishEnd === 'from' ? finish.toFrom : finish.toTo)
      if (total >= bestCost) continue
      bestCost = total
      best = dedupe([
        from,
        ...sliceFromAttachment(startEdge, start, startEnd),
        ...walkNodes(graph, startNode, finishNode, via),
        ...[...sliceFromAttachment(finishEdge, finish, finishEnd)].reverse(),
        to
      ])
    }
  }
  // Nothing reachable is not a state the committed map can be in — the whole
  // network is one component — but a hand-built graph could be, and a dwarf
  // still has to be drawn somewhere.
  return best ?? dedupe([from, to])
}
