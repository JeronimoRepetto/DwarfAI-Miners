import { describe, expect, it } from 'vitest'
import {
  mergeCloseNodes,
  simplifyPolyline,
  spliceDegreeTwoNodes,
  thinToSkeleton,
  traceSkeletonGraph
} from './skeleton.mjs'

/** Render a mask as '#'/'.' rows, for readable failure output. */
function render(mask, width, height) {
  const rows = []
  for (let y = 0; y < height; y++) {
    let row = ''
    for (let x = 0; x < width; x++) row += mask[y * width + x] ? '#' : '.'
    rows.push(row)
  }
  return rows.join('\n')
}

function filledRect(width, height, x0, y0, x1, y1) {
  const mask = new Uint8Array(width * height)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) mask[y * width + x] = 1
  }
  return mask
}

describe('thinToSkeleton', () => {
  it('erodes a filled horizontal bar to its 1px centerline', () => {
    // A 9x3 filled rectangle. Zhang-Suen also erodes ~1px off each hard
    // corner/end (there is no "arm" beyond the rectangle to preserve), so
    // the result is the middle row (y=1) shortened from both ends, not the
    // full width — verified against the real algorithm, not assumed.
    const width = 9
    const height = 3
    const mask = filledRect(width, height, 0, 0, width, height)
    const skeleton = thinToSkeleton(mask, width, height)
    expect(render(skeleton, width, height)).toBe('.........\n.######..\n.........')
  })

  it('never leaves a solid 2x2 block (the defining property of a thin skeleton)', () => {
    const width = 12
    const height = 12
    const mask = filledRect(width, height, 2, 2, 10, 10)
    const skeleton = thinToSkeleton(mask, width, height)
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const block =
          skeleton[y * width + x] +
          skeleton[y * width + x + 1] +
          skeleton[(y + 1) * width + x] +
          skeleton[(y + 1) * width + x + 1]
        expect(block).toBeLessThan(4)
      }
    }
  })
})

describe('traceSkeletonGraph + mergeCloseNodes + spliceDegreeTwoNodes', () => {
  /**
   * A T-shaped skeleton: a long horizontal bar with a long vertical stem
   * hanging from its middle. Zhang-Suen does not thin a wide intersection
   * to one pixel — it leaves a small cluster of adjacent degree>=3 pixels
   * (this is exactly the corner-artifact this pipeline's route extraction
   * hits on the real mine-interior art) — so the raw trace over-reports
   * nodes, and the merge+splice pipeline is what reduces it back to the
   * shape's real topology: one 3-way junction and three arm-ends.
   */
  function tShapeSkeleton() {
    const width = 17
    const height = 11
    const bar = filledRect(width, height, 0, 0, width, 3)
    const stem = filledRect(width, height, 7, 3, 10, height)
    const mask = bar.map((v, i) => (v || stem[i] ? 1 : 0))
    return { mask, width, height }
  }

  it('the raw trace over-reports a cluster of nodes at the intersection', () => {
    const { mask, width, height } = tShapeSkeleton()
    const skeleton = thinToSkeleton(mask, width, height)
    const graph = traceSkeletonGraph(skeleton, width, height)
    // 3 arm-ends (degree 1) plus a handful of adjacent pixels around the
    // junction that individually read as degree>=3 or degree-1.
    expect(graph.nodes.length).toBeGreaterThan(4)
    expect(graph.nodes.filter((n) => n.degree === 1)).toHaveLength(3)
  })

  it('merging and splicing reduces the T to its real topology: one junction, three arms', () => {
    const { mask, width, height } = tShapeSkeleton()
    const skeleton = thinToSkeleton(mask, width, height)
    const graph = traceSkeletonGraph(skeleton, width, height)
    const merged = mergeCloseNodes(graph.nodes, graph.edges, 3)
    const { nodes, edges } = spliceDegreeTwoNodes(merged.nodes, merged.edges)

    expect(nodes).toHaveLength(4)
    expect(edges).toHaveLength(3)

    // One node near the true junction; three arm-end nodes near the bar's
    // left end, the bar's right end, and the stem's bottom. Thinning also
    // erodes ~1-2px off every hard end (see the thinToSkeleton tests above),
    // so these are close to but not exactly the mask's own corners.
    const byProximity = (x, y) =>
      nodes.reduce(
        (best, n) => {
          const d = Math.hypot(n.x - x, n.y - y)
          return d < best.d ? { node: n, d } : best
        },
        { node: null, d: Infinity }
      )

    expect(byProximity(8, 1.5).d).toBeLessThan(1)
    expect(byProximity(1, 1).d).toBeLessThan(1)
    expect(byProximity(14, 1).d).toBeLessThan(1)
    expect(byProximity(8, 8).d).toBeLessThan(1)
  })

  it('leaves a node in place when its two edges both lead to the same neighbor', () => {
    // A small loop closing back on one other node is a real branch point,
    // not a corridor bend, so splicing must not erase it.
    const nodes = [
      { id: 0, x: 5, y: 5 },
      { id: 1, x: 0, y: 0 }
    ]
    const edges = [
      {
        a: 0,
        b: 1,
        points: [
          { x: 5, y: 5 },
          { x: 3, y: 3 },
          { x: 0, y: 0 }
        ]
      },
      {
        a: 1,
        b: 0,
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 8 },
          { x: 5, y: 5 }
        ]
      }
    ]
    const result = spliceDegreeTwoNodes(nodes, edges)
    expect(result.nodes).toHaveLength(2)
    expect(result.edges).toHaveLength(2)
  })
})

describe('mergeCloseNodes', () => {
  it('merges nodes joined by a short edge and keeps a long edge intact', () => {
    const nodes = [
      { id: 0, x: 0, y: 0, degree: 3 },
      { id: 1, x: 2, y: 0, degree: 3 },
      { id: 2, x: 20, y: 0, degree: 1 }
    ]
    const edges = [
      {
        from: 0,
        to: 1,
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 }
        ],
        closed: false
      },
      {
        from: 1,
        to: 2,
        points: Array.from({ length: 11 }, (_, i) => ({ x: 2 + i * 1.8, y: 0 })),
        closed: false
      }
    ]
    const merged = mergeCloseNodes(nodes, edges, 3)
    expect(merged.nodes).toEqual([
      { id: 0, x: 1, y: 0 }, // centroid of nodes 0 and 1
      { id: 1, x: 20, y: 0 }
    ])
    expect(merged.edges).toHaveLength(1)
    expect(merged.edges[0].a).toBe(0)
    expect(merged.edges[0].b).toBe(1)
  })

  it('keeps closed-loop edges (from === -1) untouched, separate from real nodes', () => {
    const loopEdge = {
      from: -1,
      to: -1,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 }
      ],
      closed: true
    }
    const result = mergeCloseNodes([], [loopEdge], 3)
    expect(result.loops).toEqual([loopEdge])
    expect(result.nodes).toEqual([])
    expect(result.edges).toEqual([])
  })
})

describe('spliceDegreeTwoNodes', () => {
  it('collapses a straight A-B-C chain into one A-C edge', () => {
    const nodes = [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 5, y: 0 },
      { id: 2, x: 10, y: 0 }
    ]
    const edges = [
      {
        a: 0,
        b: 1,
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 0 }
        ]
      },
      {
        a: 1,
        b: 2,
        points: [
          { x: 5, y: 0 },
          { x: 10, y: 0 }
        ]
      }
    ]
    const result = spliceDegreeTwoNodes(nodes, edges)
    expect(result.nodes).toEqual([
      { id: 0, x: 0, y: 0 },
      { id: 2, x: 10, y: 0 }
    ])
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0].a).toBe(0)
    expect(result.edges[0].b).toBe(2)
    // the shared midpoint at node 1 is not duplicated
    expect(result.edges[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 }
    ])
  })

  it('leaves true branch points (degree != 2) alone', () => {
    const nodes = [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 5, y: 0 },
      { id: 2, x: 10, y: 0 },
      { id: 3, x: 5, y: 5 }
    ]
    const edges = [
      {
        a: 0,
        b: 1,
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 0 }
        ]
      },
      {
        a: 1,
        b: 2,
        points: [
          { x: 5, y: 0 },
          { x: 10, y: 0 }
        ]
      },
      {
        a: 1,
        b: 3,
        points: [
          { x: 5, y: 0 },
          { x: 5, y: 5 }
        ]
      }
    ]
    const result = spliceDegreeTwoNodes(nodes, edges)
    expect(result.nodes).toHaveLength(4) // node 1 has degree 3, stays
    expect(result.edges).toHaveLength(3)
  })
})

describe('simplifyPolyline', () => {
  it('collapses collinear points to just the endpoints', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 }
    ]
    expect(simplifyPolyline(points, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 }
    ])
  })

  it('keeps a real corner beyond epsilon', () => {
    const bent = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 }
    ]
    expect(simplifyPolyline(bent, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 }
    ])
  })

  it('leaves inputs shorter than 3 points untouched', () => {
    const two = [
      { x: 0, y: 0 },
      { x: 1, y: 1 }
    ]
    expect(simplifyPolyline(two, 5)).toEqual(two)
  })
})
