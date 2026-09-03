import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  INTERIOR_PAINTING_SIZE,
  INTERIOR_ROUTE_EDGES,
  INTERIOR_ROUTE_NODES,
  INTERIOR_STATIONS,
  PANEL_ART_BOX,
  PANEL_BOX,
  type InteriorPoint,
  type InteriorStationKind
} from './interiorMap'

/**
 * The committed extraction, read straight off disk rather than imported.
 *
 * This file is the anti-drift check on a GENERATED module (see
 * scripts/build-interior-map.mjs), so it has to reach the same source the
 * generator did — and state the bridge formula in its own words, so a
 * hand-edited coordinate or a regeneration against a changed art box cannot
 * agree with itself.
 */
const FEATURES = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../docs/mine-interior-features.json', import.meta.url)),
    'utf8'
  )
) as {
  markers: Record<InteriorStationKind, { id: number; pixel: { x: number; y: number } }[]>
  paths: Record<
    'network' | 'stub',
    {
      nodes: { id: number; pixel: { x: number; y: number } }[]
      edges: { from: number; to: number; points: { pixel: { x: number; y: number } }[] }[]
    }
  >
}

/** The bridge, restated: a panel pixel, as a percentage of the painting. */
function expected(pixel: { x: number; y: number }): InteriorPoint {
  const round2 = (value: number): number => Math.round(value * 100) / 100
  return {
    x: round2(((pixel.x - PANEL_ART_BOX.x) / PANEL_ART_BOX.width) * 100),
    y: round2(((pixel.y - PANEL_ART_BOX.y) / PANEL_ART_BOX.height) * 100)
  }
}

/** Two image-percent points, how far apart they are on the painting itself. */
function paintingPixels(a: InteriorPoint, b: InteriorPoint): number {
  return Math.hypot(
    ((a.x - b.x) / 100) * INTERIOR_PAINTING_SIZE.width,
    ((a.y - b.y) / 100) * INTERIOR_PAINTING_SIZE.height
  )
}

const KINDS: readonly InteriorStationKind[] = ['spawn', 'worker', 'foreman', 'ladder', 'ramp']

function stationsOf(kind: InteriorStationKind): readonly InteriorStation[] {
  return INTERIOR_STATIONS.filter((station) => station.kind === kind)
}
type InteriorStation = (typeof INTERIOR_STATIONS)[number]

describe('the panel-to-painting bridge', () => {
  /*
   * The claim the whole re-anchoring rests on: the design sheet's tier panel
   * shows the WHOLE painting, so converting between them is a rescale and never
   * a crop. If the two aspect ratios ever disagree by more than measurement
   * noise, that claim is false and every coordinate below is skewed along one
   * axis — which is exactly the failure a percentage cannot show you.
   */
  it('measures a panel art box with the production painting own aspect ratio', () => {
    const panel = PANEL_ART_BOX.width / PANEL_ART_BOX.height
    const painting = INTERIOR_PAINTING_SIZE.width / INTERIOR_PAINTING_SIZE.height
    expect(Math.abs(panel - painting) / painting).toBeLessThan(0.005)
  })

  it('keeps the art box inside the panel the extraction measured against', () => {
    expect(PANEL_ART_BOX.x).toBeGreaterThanOrEqual(0)
    expect(PANEL_ART_BOX.y).toBeGreaterThanOrEqual(0)
    expect(PANEL_ART_BOX.x + PANEL_ART_BOX.width).toBeLessThanOrEqual(PANEL_BOX.width)
    expect(PANEL_ART_BOX.y + PANEL_ART_BOX.height).toBeLessThanOrEqual(PANEL_BOX.height)
  })

  it('sends the art box own corners to the painting own corners', () => {
    expect(expected({ x: PANEL_ART_BOX.x, y: PANEL_ART_BOX.y })).toEqual({ x: 0, y: 0 })
    expect(
      expected({
        x: PANEL_ART_BOX.x + PANEL_ART_BOX.width,
        y: PANEL_ART_BOX.y + PANEL_ART_BOX.height
      })
    ).toEqual({ x: 100, y: 100 })
  })

  /*
   * The white title band is the reason this step exists at all: 29 of the
   * panel's 579 rows are sheet, not art, so a raw yPercent is ~5 points of the
   * painting too low. A bridge that forgot it would place the top row of
   * workers in the ceiling.
   */
  it('lifts a point by the title band the extraction measured through', () => {
    const raw = (FEATURES.markers.worker[0]!.pixel.y / PANEL_BOX.height) * 100
    const bridged = expected(FEATURES.markers.worker[0]!.pixel).y
    expect(bridged).toBeLessThan(raw)
    expect(raw - bridged).toBeGreaterThan(3)
  })
})

describe('INTERIOR_STATIONS', () => {
  it('carries every marker the extraction found, in its own class counts', () => {
    expect(stationsOf('spawn')).toHaveLength(3)
    expect(stationsOf('worker')).toHaveLength(18)
    expect(stationsOf('foreman')).toHaveLength(3)
    expect(stationsOf('ladder')).toHaveLength(5)
    expect(stationsOf('ramp')).toHaveLength(4)
    expect(INTERIOR_STATIONS).toHaveLength(33)
  })

  /*
   * AMENDED for #153: a station carries a `facesLeft` now, which the extraction
   * says nothing about — it comes from the maintainer's authored sheet or from
   * the generator's corridor derivation (see "the authored facings" below). What
   * this case is for is the COORDINATE bridge, so the facing is set aside here
   * rather than being asserted twice in two different vocabularies.
   */
  it('re-derives every station from the committed extraction', () => {
    for (const kind of KINDS) {
      const derived = FEATURES.markers[kind].map((marker) => ({
        id: `${kind}-${marker.id}`,
        kind,
        ...expected(marker.pixel)
      }))
      const coordinates = stationsOf(kind).map(({ id, kind: itsKind, x, y }) => ({
        id,
        kind: itsKind,
        x,
        y
      }))
      expect(coordinates).toEqual(derived)
    }
  })

  it('gives every station a unique id', () => {
    expect(new Set(INTERIOR_STATIONS.map((station) => station.id)).size).toBe(
      INTERIOR_STATIONS.length
    )
  })

  it('stands every station on the painting rather than off the edge of it', () => {
    for (const station of INTERIOR_STATIONS) {
      expect(station.x, station.id).toBeGreaterThanOrEqual(0)
      expect(station.x, station.id).toBeLessThanOrEqual(100)
      expect(station.y, station.id).toBeGreaterThanOrEqual(0)
      expect(station.y, station.id).toBeLessThanOrEqual(100)
    }
  })
})

describe('the route network', () => {
  it('re-derives every node from the committed extraction', () => {
    const network = FEATURES.paths.network.nodes.map((node) => ({
      id: node.id,
      ...expected(node.pixel)
    }))
    const stub = FEATURES.paths.stub.nodes.map((node) => ({
      id: node.id + FEATURES.paths.network.nodes.length,
      ...expected(node.pixel)
    }))
    expect(INTERIOR_ROUTE_NODES).toEqual([...network, ...stub])
  })

  it('keeps every corridor between two nodes it actually has', () => {
    const ids = new Set(INTERIOR_ROUTE_NODES.map((node) => node.id))
    for (const edge of INTERIOR_ROUTE_EDGES) {
      expect(ids.has(edge.from), `${edge.from}`).toBe(true)
      expect(ids.has(edge.to), `${edge.to}`).toBe(true)
      expect(edge.points.length).toBeGreaterThanOrEqual(2)
    }
  })

  /*
   * The committed extraction renumbers each component's nodes but leaves its
   * edge endpoints on the ids the skeleton graph carried BEFORE that
   * renumbering, so taken literally not one edge in it points at a node that
   * exists. This is the pin on the repair: it is stated as the thing the
   * dataset does, so a future re-extraction that fixes it upstream fails here
   * and gets the now-pointless repair deleted rather than silently double-
   * applied.
   */
  it('needs the endpoint repair, because the extraction own edge ids name no node', () => {
    const nodeIds = new Set(FEATURES.paths.network.nodes.map((node) => node.id))
    const endpoints = new Set(FEATURES.paths.network.edges.flatMap((edge) => [edge.from, edge.to]))
    expect(endpoints.size).toBe(nodeIds.size)
    expect([...endpoints].some((id) => !nodeIds.has(id))).toBe(true)
  })

  /*
   * And this is what proves the repair picked the RIGHT nodes rather than
   * merely plausible ones: the extraction's simplifier keeps a polyline's own
   * endpoints exactly, so every corridor's first and last point have to sit on
   * the two junctions it claims. A wrong mapping could not manage that 22 times
   * over.
   */
  it('starts and ends every corridor on the two junctions it names', () => {
    const at = (id: number): InteriorPoint =>
      INTERIOR_ROUTE_NODES.find((node) => node.id === id) as InteriorPoint
    for (const edge of INTERIOR_ROUTE_EDGES) {
      const first = edge.points[0] as InteriorPoint
      const last = edge.points[edge.points.length - 1] as InteriorPoint
      const where = `${edge.from}-${edge.to}`
      expect(paintingPixels(first, at(edge.from)), where).toBeLessThan(40)
      expect(paintingPixels(last, at(edge.to)), where).toBeLessThan(40)
    }
  })

  it('keeps every corridor point on the painting', () => {
    for (const edge of INTERIOR_ROUTE_EDGES) {
      for (const point of edge.points) {
        expect(point.x).toBeGreaterThanOrEqual(0)
        expect(point.x).toBeLessThanOrEqual(100)
        expect(point.y).toBeGreaterThanOrEqual(0)
        expect(point.y).toBeLessThanOrEqual(100)
      }
    }
  })

  /*
   * The extraction reports two components, and docs/map-coordinates.md §3.2
   * reads the smaller one as a real spur whose join is painted over rather than
   * a genuine gap. Left as extracted it would strand the entrance: a dwarf
   * spawning there could reach nothing. One bridging edge is the whole fix, and
   * this is the test that says the fix is still applied.
   */
  it('joins the entrance stub to the network with exactly one bridging edge', () => {
    expect(INTERIOR_ROUTE_EDGES.filter((edge) => edge.bridged === true)).toHaveLength(1)
  })

  it('leaves one connected network, so every corridor is reachable from every other', () => {
    const neighbours = new Map<number, number[]>()
    for (const edge of INTERIOR_ROUTE_EDGES) {
      neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to])
      neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from])
    }
    const seen = new Set<number>([INTERIOR_ROUTE_NODES[0]!.id])
    const queue = [INTERIOR_ROUTE_NODES[0]!.id]
    while (queue.length > 0) {
      for (const next of neighbours.get(queue.pop() as number) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    expect(seen.size).toBe(INTERIOR_ROUTE_NODES.length)
  })
})

/**
 * The authored facings (#153), read straight off the sheet rather than imported,
 * for the same reason every coordinate above is: this is the anti-drift check on
 * a GENERATED module, so it has to reach the same source the generator did.
 */
const AUTHORED = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../docs/mine-interior-facing.json', import.meta.url)),
    'utf8'
  )
) as { facing: Record<string, 'left' | 'right'> }

/*
 * Which way a dwarf faces is DATA in this file, never a rule the renderer
 * applies (#153). What shipped was `facesLeft = x > 50` — "face the middle of
 * the shaft" — and the maintainer's acceptance run found it wrong for thirteen
 * of the eighteen worker stations: a dwarf faces the WALL it is picking, and
 * which wall that is depends on the rock rather than on which half of the
 * painting the station sits in.
 *
 * They then authored it. Every workstation carries a blue arrow in all five tier
 * panels of the comparison sheet, all five agreed on every station, and
 * `docs/mine-interior-facing.json` is that transcription. Stations the sheet
 * does not author — the three foreman spots, and the ladders and ramps nobody
 * stands on — take the generator's own derivation: a station sits beside a
 * corridor and turns away from it, into the rock.
 */
describe('the authored facings', () => {
  it('ships every station with a facing, so nothing is decided at render time', () => {
    for (const station of INTERIOR_STATIONS) {
      expect(typeof station.facesLeft, station.id).toBe('boolean')
    }
  })

  it('carries the maintainer’s own sheet verbatim, station for station', () => {
    for (const [id, side] of Object.entries(AUTHORED.facing)) {
      const station = INTERIOR_STATIONS.find((candidate) => candidate.id === id)
      expect(station, id).toBeDefined()
      expect(station?.facesLeft, id).toBe(side === 'left')
    }
  })

  it('authors every workstation, which is what the sheet draws an arrow on', () => {
    const workers = INTERIOR_STATIONS.filter((station) => station.kind === 'worker')
    for (const worker of workers) {
      expect(Object.keys(AUTHORED.facing), worker.id).toContain(worker.id)
    }
    expect(Object.keys(AUTHORED.facing)).toHaveLength(workers.length)
  })

  it('lets the derivation answer where the sheet is silent', () => {
    // The foremen carry no arrow: nothing in the sheet says which way a
    // coordinator turns, so the corridor beside the station decides.
    for (const foreman of INTERIOR_STATIONS.filter((station) => station.kind === 'foreman')) {
      expect(Object.keys(AUTHORED.facing), foreman.id).not.toContain(foreman.id)
      expect(typeof foreman.facesLeft, foreman.id).toBe('boolean')
    }
  })

  it('disagrees with the shaft-middle rule on most of the crew, which is the point', () => {
    const differing = INTERIOR_STATIONS.filter(
      (station) => station.kind === 'worker' && station.facesLeft !== station.x > 50
    )
    expect(differing).toHaveLength(13)
  })
})
