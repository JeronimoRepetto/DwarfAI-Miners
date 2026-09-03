/**
 * Turns a binary blob (the "gray route line" mask for one mine-interior
 * panel) into ordered polylines, the honest alternative to a point list for
 * a marker class that is a *shape*: `extract-map-coordinates.mjs` reduces
 * every red/blue/orange/purple/magenta marker to a centroid because each one
 * IS a point, but a route is a path a dwarf walks along, and collapsing it
 * to a centroid would throw away exactly the information the mine-interior
 * phase needs (issue #89).
 *
 * Method: Zhang-Suen thinning reduces the filled blob to a 1px-wide
 * skeleton, then the skeleton is walked as a graph — degree-1 pixels are
 * endpoints, degree-3+ pixels are junctions, and the pixel run between two
 * such nodes becomes one polyline. A component with no junction or endpoint
 * at all (every pixel has exactly two skeleton neighbors) is a closed loop;
 * it is walked all the way around and returned as a single closed polyline
 * instead of being silently dropped for having no nodes to cut at.
 *
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ id: number, x: number, y: number, degree: number }} Node
 * @typedef {{ from: number, to: number, points: Point[], closed: boolean }} Edge
 */

/** The 8 neighbor offsets in the clockwise order Zhang-Suen numbers P2..P9. */
const NEIGHBOR_OFFSETS = [
  [0, -1], // P2 above
  [1, -1], // P3
  [1, 0], // P4 right
  [1, 1], // P5
  [0, 1], // P6 below
  [-1, 1], // P7
  [-1, 0], // P8 left
  [-1, -1] // P9
]

function at(mask, width, height, x, y) {
  if (x < 0 || x >= width || y < 0 || y >= height) return 0
  return mask[y * width + x]
}

/**
 * One Zhang-Suen sub-iteration. Marks pixels for removal per `step`'s
 * condition set without mutating `mask` mid-pass (removal decisions must all
 * see the same generation).
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {1 | 2} step
 * @returns {number[]} flat indices to clear
 */
function markRemovals(mask, width, height, step) {
  const toRemove = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (at(mask, width, height, x, y) !== 1) continue
      const p = NEIGHBOR_OFFSETS.map(([dx, dy]) => at(mask, width, height, x + dx, y + dy))
      const blackNeighbors = p.reduce((sum, v) => sum + v, 0)
      if (blackNeighbors < 2 || blackNeighbors > 6) continue

      let transitions = 0
      for (let i = 0; i < 8; i++) {
        if (p[i] === 0 && p[(i + 1) % 8] === 1) transitions++
      }
      if (transitions !== 1) continue

      // Only the four cardinal neighbors gate removal in either step; the
      // four diagonals already did their work in the blackNeighbors/transitions
      // checks above.
      const [p2, , p4, , p6, , p8] = p
      if (step === 1) {
        if (p2 * p4 * p6 !== 0) continue
        if (p4 * p6 * p8 !== 0) continue
      } else {
        if (p2 * p4 * p8 !== 0) continue
        if (p2 * p6 * p8 !== 0) continue
      }
      toRemove.push(y * width + x)
    }
  }
  return toRemove
}

/**
 * Zhang-Suen thinning: erode a filled binary mask down to a 1px-wide
 * skeleton that preserves the original shape's topology (branches, loops).
 * Runs to a fixed point — passes stop once neither sub-iteration removes a
 * pixel — which is always reached because every pass strictly shrinks the
 * foreground pixel count or leaves it unchanged.
 *
 * @param {Uint8Array} mask width*height, 1 = foreground
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} a new mask, the skeleton
 */
export function thinToSkeleton(mask, width, height) {
  const working = Uint8Array.from(mask)
  for (;;) {
    const first = markRemovals(working, width, height, 1)
    for (const index of first) working[index] = 0
    const second = markRemovals(working, width, height, 2)
    for (const index of second) working[index] = 0
    if (first.length === 0 && second.length === 0) break
  }
  return working
}

/** Count of skeleton-pixel 8-neighbors, i.e. this pixel's graph degree. */
function degreeAt(skeleton, width, height, x, y) {
  let degree = 0
  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    if (at(skeleton, width, height, x + dx, y + dy) === 1) degree++
  }
  return degree
}

/**
 * Walk the skeleton as a graph: cut it into ordered polylines at every
 * endpoint (degree 1) and junction (degree >= 3), plus one closed polyline
 * per loop-shaped component that has neither.
 *
 * @param {Uint8Array} skeleton width*height, 1 = skeleton pixel
 * @param {number} width
 * @param {number} height
 * @returns {{ nodes: Node[], edges: Edge[] }}
 */
export function traceSkeletonGraph(skeleton, width, height) {
  const degree = new Int8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (skeleton[y * width + x] !== 1) continue
      degree[y * width + x] = degreeAt(skeleton, width, height, x, y)
    }
  }

  /** @type {Node[]} */
  const nodes = []
  const nodeIdAt = new Map() // flat index -> node id
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (skeleton[p] !== 1) continue
      const d = degree[p]
      if (d === 1 || d >= 3) {
        nodeIdAt.set(p, nodes.length)
        nodes.push({ id: nodes.length, x, y, degree: d })
      }
    }
  }

  const visitedDirected = new Set() // `${fromPixel}->${toPixel}` already walked as part of an edge
  /** @type {Edge[]} */
  const edges = []

  function walkFrom(startPixel, firstStepPixel) {
    const points = [
      { x: startPixel % width, y: Math.floor(startPixel / width) },
      { x: firstStepPixel % width, y: Math.floor(firstStepPixel / width) }
    ]
    let previous = startPixel
    let current = firstStepPixel
    // Mark both directions consumed: once this pixel step is part of an
    // edge, a walk starting from the far end must not retrace it and
    // rediscover the same edge a second time.
    visitedDirected.add(`${previous}->${current}`)
    visitedDirected.add(`${current}->${previous}`)
    while (!nodeIdAt.has(current)) {
      const cx = current % width
      const cy = Math.floor(current / width)
      let next = -1
      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const nx = cx + dx
        const ny = cy + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        const np = ny * width + nx
        if (np === previous) continue
        if (at(skeleton, width, height, nx, ny) === 1) {
          next = np
          break
        }
      }
      if (next === -1) break // dangling: thinning left a 1px stub with no forward neighbor
      points.push({ x: next % width, y: Math.floor(next / width) })
      visitedDirected.add(`${current}->${next}`)
      visitedDirected.add(`${next}->${current}`)
      previous = current
      current = next
    }
    return { points, endPixel: current }
  }

  for (const node of nodes) {
    const p = node.y * width + node.x
    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
      const nx = node.x + dx
      const ny = node.y + dy
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
      const np = ny * width + nx
      if (at(skeleton, width, height, nx, ny) !== 1) continue
      if (visitedDirected.has(`${p}->${np}`)) continue
      const { points, endPixel } = walkFrom(p, np)
      const endNodeId = nodeIdAt.get(endPixel)
      if (endNodeId === undefined) continue // dangling stub, not a real edge to another node
      edges.push({ from: node.id, to: endNodeId, points, closed: false })
    }
  }

  // A component that is a pure loop has no endpoint/junction pixels at all,
  // so the pass above finds no nodes and traces nothing for it. Detect and
  // walk those separately: pick any unvisited skeleton pixel, walk one
  // direction all the way around back to the start.
  const visitedLoop = new Uint8Array(width * height)
  for (const edge of edges) {
    for (const pt of edge.points) visitedLoop[pt.y * width + pt.x] = 1
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (skeleton[p] !== 1 || visitedLoop[p] === 1) continue
      // Every pixel here has degree exactly 2 (else it would already be a
      // node); walk forward from an arbitrary neighbor until back at start.
      let firstNeighbor = -1
      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const nx = x + dx
        const ny = y + dy
        if (at(skeleton, width, height, nx, ny) === 1) {
          firstNeighbor = ny * width + nx
          break
        }
      }
      if (firstNeighbor === -1) continue
      const points = [{ x, y }]
      let previous = p
      let current = firstNeighbor
      points.push({ x: current % width, y: Math.floor(current / width) })
      visitedLoop[p] = 1
      visitedLoop[current] = 1
      while (current !== p) {
        const cx = current % width
        const cy = Math.floor(current / width)
        let next = -1
        for (const [dx, dy] of NEIGHBOR_OFFSETS) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const np = ny * width + nx
          if (np === previous) continue
          if (at(skeleton, width, height, nx, ny) === 1) {
            next = np
            break
          }
        }
        if (next === -1) break
        points.push({ x: next % width, y: Math.floor(next / width) })
        visitedLoop[next] = 1
        previous = current
        current = next
      }
      edges.push({ from: -1, to: -1, points, closed: current === p })
    }
  }

  return { nodes, edges }
}

/**
 * Douglas-Peucker simplification: drop points that sit within `epsilon`
 * pixels of the straight line between their neighbors. Keeps the exported
 * JSON a reasonable size without changing the path's visible shape — a
 * single-pixel-wide skeleton produces one point per pixel of travel, most of
 * which lie on (or a sub-pixel from) a straight run.
 *
 * @param {Point[]} points
 * @param {number} epsilon max perpendicular distance, in source pixels, to drop a point
 * @returns {Point[]}
 */
export function simplifyPolyline(points, epsilon) {
  if (points.length < 3) return points.slice()

  function perpendicularDistance(pt, a, b) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSquared = dx * dx + dy * dy
    if (lengthSquared === 0) return Math.hypot(pt.x - a.x, pt.y - a.y)
    const t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lengthSquared
    const projX = a.x + t * dx
    const projY = a.y + t * dy
    return Math.hypot(pt.x - projX, pt.y - projY)
  }

  function recurse(pts) {
    if (pts.length < 3) return pts
    const first = pts[0]
    const last = pts[pts.length - 1]
    let maxDist = -1
    let maxIndex = -1
    for (let i = 1; i < pts.length - 1; i++) {
      const dist = perpendicularDistance(pts[i], first, last)
      if (dist > maxDist) {
        maxDist = dist
        maxIndex = i
      }
    }
    if (maxDist <= epsilon) return [first, last]
    const left = recurse(pts.slice(0, maxIndex + 1))
    const right = recurse(pts.slice(maxIndex))
    return left.slice(0, -1).concat(right)
  }

  return recurse(points)
}

/**
 * @typedef {{ id: number, x: number, y: number }} TopoNode
 * @typedef {{ a: number, b: number, points: Point[] }} TopoEdge
 *   Undirected; `points` runs from node `a`'s pixel to node `b`'s pixel.
 */

/**
 * Collapse thinning-corner artifacts into single nodes. A pixel-wide
 * skeleton run through a sharp turn or a wide intersection often thins down
 * to a small cluster of 2-4 adjacent degree>=3/degree-1 pixels rather than
 * exactly one, connected to each other by very short edges — the corner has
 * width, the skeleton does not. Union-Find merges every edge at or under
 * `maxClusterEdgePoints` pixels long into one node at the cluster's
 * centroid; longer edges become the real edges between (possibly newly
 * merged) nodes. `closed`-loop edges (traceSkeletonGraph's `from === -1`
 * pure-loop components) pass straight through, unmerged: they have no node
 * to cluster into.
 *
 * @param {Node[]} nodes from traceSkeletonGraph
 * @param {Edge[]} edges from traceSkeletonGraph
 * @param {number} maxClusterEdgePoints
 * @returns {{ nodes: TopoNode[], edges: TopoEdge[], loops: Edge[] }}
 */
export function mergeCloseNodes(nodes, edges, maxClusterEdgePoints) {
  const parent = nodes.map((_, i) => i)
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  function union(a, b) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  const loops = []
  const realEdgesRaw = []
  for (const edge of edges) {
    if (edge.from === -1) {
      loops.push(edge)
      continue
    }
    if (edge.points.length <= maxClusterEdgePoints) {
      union(edge.from, edge.to)
    } else {
      realEdgesRaw.push(edge)
    }
  }

  const clusterMembers = new Map()
  for (const node of nodes) {
    const root = find(node.id)
    if (!clusterMembers.has(root)) clusterMembers.set(root, [])
    clusterMembers.get(root).push(node)
  }
  const rootToId = new Map()
  const mergedNodes = []
  for (const [root, members] of clusterMembers) {
    const x = members.reduce((sum, m) => sum + m.x, 0) / members.length
    const y = members.reduce((sum, m) => sum + m.y, 0) / members.length
    rootToId.set(root, mergedNodes.length)
    mergedNodes.push({ id: mergedNodes.length, x, y })
  }

  const mergedEdges = []
  for (const edge of realEdgesRaw) {
    const a = rootToId.get(find(edge.from))
    const b = rootToId.get(find(edge.to))
    if (a === b) continue // collapsed into one cluster: a tiny internal loop, not a real corridor
    mergedEdges.push({ a, b, points: edge.points })
  }

  return { nodes: mergedNodes, edges: mergedEdges, loops }
}

/**
 * Splice out every node that is a plain pass-through (exactly two edges
 * touching it), concatenating its two edges into one. A bend in a corridor
 * is shape, not a decision point — `simplifyPolyline` is what should decide
 * whether the bend's pixels stay in the output, not the graph topology.
 * Iterative (a worklist, not one pass): removing a pass-through node can
 * turn its neighbor into a new pass-through, notably along a straight run
 * that thinned into a chain of several almost-collinear degree-2 pixels.
 *
 * @param {TopoNode[]} nodes
 * @param {TopoEdge[]} edges
 * @returns {{ nodes: TopoNode[], edges: TopoEdge[] }}
 */
export function spliceDegreeTwoNodes(nodes, edges) {
  const edgeById = new Map(edges.map((edge, i) => [i, edge]))
  const adjacency = new Map(nodes.map((n) => [n.id, []])) // nodeId -> [{ edgeId, other }]
  for (const [edgeId, edge] of edgeById) {
    adjacency.get(edge.a).push({ edgeId, other: edge.b })
    adjacency.get(edge.b).push({ edgeId, other: edge.a })
  }

  function orderedPoints(edge, fromId) {
    return edge.a === fromId ? edge.points : edge.points.slice().reverse()
  }

  const queue = nodes.map((n) => n.id)
  const removedNodes = new Set()
  let nextEdgeId = edges.length

  while (queue.length > 0) {
    const id = queue.pop()
    if (removedNodes.has(id)) continue
    const adj = adjacency.get(id)
    if (adj.length !== 2) continue
    const [first, second] = adj
    const edge1 = edgeById.get(first.edgeId)
    const edge2 = edgeById.get(second.edgeId)
    if (edge1 === undefined || edge2 === undefined) continue // one side already spliced this pass

    const otherA = first.other
    const otherB = second.other
    // A node whose two edges both lead to the same neighbor is where a
    // small loop closes back on itself — a real branch point, not a bend —
    // so it is left in place rather than spliced away.
    if (otherA === otherB) continue
    const pointsIntoNode = orderedPoints(edge1, otherA) // otherA -> id
    const pointsOutOfNode = orderedPoints(edge2, id) // id -> otherB
    const combinedPoints = pointsIntoNode.slice(0, -1).concat(pointsOutOfNode)

    edgeById.delete(first.edgeId)
    edgeById.delete(second.edgeId)
    removedNodes.add(id)

    const newEdgeId = nextEdgeId++
    edgeById.set(newEdgeId, { a: otherA, b: otherB, points: combinedPoints })

    for (const neighborId of new Set([otherA, otherB])) {
      if (removedNodes.has(neighborId) || neighborId === id) continue
      for (const entry of adjacency.get(neighborId)) {
        if (entry.edgeId !== first.edgeId && entry.edgeId !== second.edgeId) continue
        entry.edgeId = newEdgeId
        entry.other = neighborId === otherA ? otherB : otherA
      }
      queue.push(neighborId)
    }
  }

  return {
    nodes: nodes.filter((n) => !removedNodes.has(n.id)),
    edges: [...edgeById.values()]
  }
}
