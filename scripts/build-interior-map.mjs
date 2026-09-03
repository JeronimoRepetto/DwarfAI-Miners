#!/usr/bin/env node
/**
 * Re-anchors the extracted mine-interior features onto the production painting
 * and writes them out as `src/renderer/src/lib/scene/interiorMap.ts`.
 *
 *   node scripts/build-interior-map.mjs
 *
 * ## Why a step exists at all
 *
 * `docs/mine-interior-features.json` (#134) is measured in percent of ONE
 * 182x579 tier panel cropped out of a five-panel comparison sheet — and that
 * panel is not the painting. It carries the sheet's own white title band above
 * the art and a hairline of white gutter down each side, so a percentage taken
 * against it is a percentage of a slightly larger box than the art it names.
 * `docs/map-coordinates.md` §4 says so in as many words and refuses to author
 * from those numbers directly: "re-anchor, don't hand-adjust".
 *
 * This is that re-anchoring, done once, in code that can be re-run when the art
 * or the extraction changes rather than by nudging coordinates until they look
 * right.
 *
 * ## The bridge, in one paragraph
 *
 * Inside its 182x579 box the Bronze panel draws the art at
 * x 0.60-179.70, y 29.34-577.91 — measured off `mine-interior-variants.png` by
 * reading the mean luminance of each boundary row and column and solving the
 * antialiased edge pixel's coverage (a boundary pixel's luminance is a linear
 * blend of the white sheet and the near-black art, so its coverage recovers the
 * edge to a fraction of a pixel). That art box is 179.10 x 548.57, aspect
 * 0.3265 — against the production painting's own 1184x3622, aspect 0.3269, a
 * 0.12% disagreement. So the panel shows the WHOLE painting, scaled: the
 * transform is a crop-and-rescale, with no cropping of the art itself.
 *
 * Every marker and route point therefore converts by
 *
 *     paintingPercent = (panelPixel - artBoxOrigin) / artBoxSize * 100
 *
 * and lands in the painting's own image-percent space — the convention
 * `sceneGeometry.projectToBox` consumes and `.claude/rules/coordinates.md`
 * calls "image percent, projected at render time".
 *
 * ## What it decides on the way through
 *
 * - **One map for all five tiers.** `screens/mine.md`: "Each interior variant
 *   shares the same symmetric logical map; only the visual style changes", and
 *   §3.1 of the report confirmed it by count rather than assuming it. The
 *   committed dataset is the Bronze panel, and Bronze/Gold/Uranium's route
 *   topologies agree exactly, so Silver's flagged extraction (palette overlap,
 *   53 spurious nodes) and Cropper's extra node/edge pair are never consulted:
 *   one topology serves every tier.
 * - **The stub is spliced into the network.** The route mask comes out as two
 *   components; §3.2 reads the smaller one as a real spur whose join is hidden
 *   under the painted entrance decoration rather than a genuine gap. Left
 *   disconnected it would strand the entrance, so the two nearest endpoints are
 *   joined by one straight edge, marked `bridged` so the seam stays visible.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import prettier from 'prettier'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(REPO_ROOT, 'docs', 'mine-interior-features.json')
const FACING = join(REPO_ROOT, 'docs', 'mine-interior-facing.json')
const TARGET = join(REPO_ROOT, 'src', 'renderer', 'src', 'lib', 'scene', 'interiorMap.ts')

/**
 * Where the Bronze panel draws the painting inside its own 182x579 box, in
 * panel pixels. See the header for how the four numbers were measured.
 */
export const PANEL_ART_BOX = { x: 0.6, y: 29.34, width: 179.1, height: 548.57 }

/** The panel box the extraction measured its percentages against. */
export const PANEL_BOX = { width: 182, height: 579 }

/** The production painting all five tiers are drawn at. */
export const PAINTING_SIZE = { width: 1184, height: 3622 }

/** Marker classes, in the order they are emitted. Ladders and ramps included:
 * nothing stands on them, but they are the route features the design names and
 * a consumer that wants to draw or debug the map should be able to see them. */
const STATION_KINDS = ['spawn', 'worker', 'foreman', 'ladder', 'ramp']

function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * One panel-space pixel to painting image-percent.
 *
 * Deliberately un-clamped: a point outside 0-100 would mean the measured art
 * box is wrong, and silently pulling it inside would hide exactly that.
 */
export function toPaintingPercent(pixel) {
  return {
    x: round2(((pixel.x - PANEL_ART_BOX.x) / PANEL_ART_BOX.width) * 100),
    y: round2(((pixel.y - PANEL_ART_BOX.y) / PANEL_ART_BOX.height) * 100)
  }
}

/**
 * How far apart two image-percent points are, in PAINTING PIXELS.
 *
 * Percent-space distance would be a lie on art this shape: the painting is
 * three times taller than it is wide, so one percent of height is three times
 * one percent of width, and a naive hypotenuse would call a long vertical drop
 * "nearer" than a short sideways step.
 */
function distance(a, b) {
  return Math.hypot(
    ((a.x - b.x) / 100) * PAINTING_SIZE.width,
    ((a.y - b.y) / 100) * PAINTING_SIZE.height
  )
}

/**
 * Repair one component's edge endpoints, which the extraction left dangling.
 *
 * `docs/mine-interior-features.json` renumbers each component's `nodes` 0..n-1
 * but leaves `edges[].from`/`to` on the ids the skeleton graph carried BEFORE
 * that renumbering — Bronze's 18 nodes are 0..17 while its edges name ids up to
 * 32, and the stub's 2 nodes are 0..1 while its one edge names 4 and 2. Taken
 * literally, not a single edge in the dataset points at a node that exists.
 *
 * The mapping is recoverable and is not a guess: each component's edges name
 * exactly as many distinct ids as it has nodes, and sorting those ids ascending
 * lines them up with the renumbered nodes in order. The `assertEndpoints` check
 * below proves it rather than assuming it — every edge's own polyline has to
 * start and end on the two nodes this mapping picked out, which a wrong mapping
 * could not manage 21 times in a row.
 *
 * Reported upstream rather than papered over; see the commit for #137.
 */
function reindexComponent(component) {
  const originalIds = [...new Set(component.edges.flatMap((edge) => [edge.from, edge.to]))].sort(
    (a, b) => a - b
  )
  if (originalIds.length !== component.nodes.length) {
    throw new Error(
      `component names ${originalIds.length} edge endpoints for ${component.nodes.length} nodes`
    )
  }
  const index = new Map(originalIds.map((id, position) => [id, position]))
  const nodes = component.nodes.map((node) => ({ id: node.id, ...toPaintingPercent(node.pixel) }))
  const edges = component.edges.map((edge) => {
    const from = index.get(edge.from)
    const to = index.get(edge.to)
    const points = edge.points.map((point) => toPaintingPercent(point.pixel))
    // The graph is undirected and the polyline may be traced either way round.
    // Normalizing here means every consumer can walk `points` from `from` to
    // `to` without re-checking which end it started at.
    const head = points[0]
    const forward = distance(head, nodes[from]) <= distance(head, nodes[to])
    return { from, to, points: forward ? points : [...points].reverse() }
  })
  return { nodes, edges }
}

/**
 * Every edge's polyline must land on the nodes it claims. The extraction's
 * simplifier keeps a polyline's endpoints exactly, and node positions come from
 * a merge cluster of radius 6, so anything beyond a few pixels means the
 * endpoint repair above matched the wrong node.
 */
function assertEndpoints(component, tolerancePx) {
  for (const edge of component.edges) {
    const first = edge.points[0]
    const last = edge.points[edge.points.length - 1]
    const head = distance(first, component.nodes[edge.from])
    const tail = distance(last, component.nodes[edge.to])
    if (head > tolerancePx || tail > tolerancePx) {
      throw new Error(
        `edge ${edge.from}-${edge.to} misses its nodes by ${round2(head)}px / ${round2(tail)}px`
      )
    }
  }
}

/**
 * Join the stub component to the main network at the closest pair of nodes.
 *
 * Returns the merged node list (stub ids shifted past the network's) and the
 * merged edge list, with one straight bridging edge appended.
 */
export function spliceStub(rawNetwork, rawStub) {
  const network = reindexComponent(rawNetwork)
  const stub = reindexComponent(rawStub)
  // The painting is 1184x3622, so 40px is about 1% of its longest side — well
  // past the 6px merge radius and the 1.5px simplifier epsilon, and far short
  // of the distance to any other node.
  assertEndpoints(network, 40)
  assertEndpoints(stub, 40)

  const offset = network.nodes.length
  const nodes = [...network.nodes, ...stub.nodes.map((node) => ({ ...node, id: node.id + offset }))]
  const edges = [
    ...network.edges,
    ...stub.edges.map((edge) => ({ ...edge, from: edge.from + offset, to: edge.to + offset }))
  ]

  let best
  for (const from of nodes.slice(0, offset)) {
    for (const to of nodes.slice(offset)) {
      const span = distance(from, to)
      if (!best || span < best.span) best = { from: from.id, to: to.id, span }
    }
  }
  if (!best) throw new Error('no stub node to bridge to')
  const from = nodes.find((node) => node.id === best.from)
  const to = nodes.find((node) => node.id === best.to)
  edges.push({ from: best.from, to: best.to, points: [from, to], bridged: true })
  return { nodes, edges, bridgeSpan: best.span }
}

/**
 * How close to a corridor is "standing on it", in painting pixels.
 *
 * A station whose nearest corridor point is directly above or below it has no
 * side to turn away from, and 12px is under one screen pixel at the design's own
 * column — far below anything a viewer could see.
 */
const FACING_EPSILON_PX = 12

/** Where on the segment `a`-`b` the foot of the perpendicular from `p` falls, 0-1. */
function projectOntoSegment(p, a, b) {
  // In painting pixels, so the projection is a real perpendicular rather than
  // one skewed by the art's 1:3 shape.
  const ax = (a.x / 100) * PAINTING_SIZE.width
  const ay = (a.y / 100) * PAINTING_SIZE.height
  const bx = (b.x / 100) * PAINTING_SIZE.width
  const by = (b.y / 100) * PAINTING_SIZE.height
  const px = (p.x / 100) * PAINTING_SIZE.width
  const py = (p.y / 100) * PAINTING_SIZE.height
  const dx = bx - ax
  const dy = by - ay
  const squared = dx * dx + dy * dy
  if (squared === 0) return 0
  return Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / squared, 0), 1)
}

/**
 * The closest point on the whole corridor network to `point`, in image percent.
 *
 * Segments rather than junctions, for the reason `interiorRoute.nearestOnRoute`
 * gives at render time: a station halfway along a gallery attaches to the
 * gallery beside it, not to the stairs at its end.
 */
function nearestOnEdges(point, edges) {
  let best
  for (const edge of edges) {
    for (let index = 0; index + 1 < edge.points.length; index++) {
      const a = edge.points[index]
      const b = edge.points[index + 1]
      const t = projectOntoSegment(point, a, b)
      const on = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      const span = distance(point, on)
      if (!best || span < best.span) best = { point: on, span }
    }
  }
  return best
}

/**
 * Which way a dwarf standing here faces, derived from the corridors around it.
 *
 * The maintainer's rule: a dwarf faces the WALL it is picking. A workstation is
 * marked BESIDE a corridor — the dwarf steps off the path and turns to the rock
 * — so the rock is on the side away from the nearest corridor point, and that is
 * the whole derivation. Distances are painting pixels, never percent, for the
 * reason the header already gives about this art's 1:3 shape.
 *
 * A station standing ON its corridor has no side to read; it falls back to
 * `x > 50`, the "face the middle of the shaft" rule that used to decide every
 * station. That rule is a coincidence rather than a principle — it agrees with
 * the maintainer's authored sheet on five of eighteen workers — so it survives
 * only where there is genuinely nothing better to say.
 */
export function facingFromRoute(station, edges) {
  const near = nearestOnEdges(station, edges)
  if (!near) return station.x > 50
  const dx = ((near.point.x - station.x) / 100) * PAINTING_SIZE.width
  if (Math.abs(dx) < FACING_EPSILON_PX) return station.x > 50
  // The corridor is to the right, so the rock the dwarf works is to the left.
  return dx > 0
}

/**
 * The facing this station actually ships with: the authored one if the
 * maintainer drew an arrow on it, the derivation otherwise.
 *
 * An authored value WINS outright and is never averaged with anything: an arrow
 * drawn on the art is evidence, and the derivation is an inference from a
 * corridor mask. A value the sheet spells wrong throws rather than falling back,
 * because silently deriving where an override was intended is the one failure
 * that would look exactly like the override working.
 */
export function stationFacing(station, edges, overrides) {
  const authored = overrides[station.id]
  if (authored === undefined) return facingFromRoute(station, edges)
  if (authored === 'left') return true
  if (authored === 'right') return false
  throw new Error(`authored facing for ${station.id} is neither 'left' nor 'right': ${authored}`)
}

function formatPoint(point) {
  return `{ x: ${point.x}, y: ${point.y} }`
}

async function build() {
  const source = JSON.parse(readFileSync(SOURCE, 'utf8'))
  const overrides = JSON.parse(readFileSync(FACING, 'utf8')).facing ?? {}

  const stations = []
  for (const kind of STATION_KINDS) {
    for (const marker of source.markers[kind]) {
      stations.push({ id: `${kind}-${marker.id}`, kind, ...toPaintingPercent(marker.pixel) })
    }
  }

  const route = spliceStub(source.paths.network, source.paths.stub)

  // An authored facing for a station that does not exist is a typo that would
  // otherwise do nothing at all, quietly — the sheet is transcribed by hand.
  for (const id of Object.keys(overrides)) {
    if (!stations.some((station) => station.id === id)) {
      throw new Error(`authored facing names ${id}, which is not a station in the extraction`)
    }
  }
  for (const station of stations) {
    station.facesLeft = stationFacing(station, route.edges, overrides)
  }

  const lines = []
  lines.push(`/**
 * The mine interior's logical map: every place a dwarf can stand, and every
 * corridor between them, in percent of the painting.
 *
 * GENERATED by \`node scripts/build-interior-map.mjs\` from
 * \`docs/mine-interior-features.json\` and \`docs/mine-interior-facing.json\` —
 * never edit the coordinates or the facings by hand.
 * That script's header carries the whole argument: why the extracted dataset's
 * own percentages are NOT these ones, how the panel's art box was measured, and
 * why one topology serves all five tiers. Read it before changing a number.
 *
 * ## The coordinate space
 *
 * Percentages of the PAINTING (\`inside-mines/inside-<tier>-mine.jpg\`,
 * 1184x3622), not of the rendered box — the convention
 * \`.claude/rules/coordinates.md\` calls image percent, projected to the box at
 * render time by \`sceneGeometry.projectToBox\`. All five tier paintings share
 * one composition and therefore one map; only the ore is recoloured.
 *
 * ## Order is load-bearing
 *
 * Stations keep the extraction's own order within each class, because a
 * station's INDEX inside its class is the slot \`sceneAssignment\` hashes a
 * dwarf id onto. Re-ordering this list moves every dwarf in every mine.
 */

/** A point on the painting, in percent of the painting's own canvas. */
export interface InteriorPoint {
  x: number
  y: number
}

/**
 * What the design's spatial map draws at a point (\`screens/mine.md\`): a red
 * spawn circle, a blue worker triangle, an orange foreman diamond, a purple
 * ladder arrow or a magenta ramp square.
 */
export type InteriorStationKind = 'spawn' | 'worker' | 'foreman' | 'ladder' | 'ramp'

/** One extracted marker, at the dwarf's feet. */
export interface InteriorStation extends InteriorPoint {
  id: string
  kind: InteriorStationKind
  /**
   * Whether a dwarf standing here faces left.
   *
   * The sheets are PAINTED FACING LEFT (#156), so this value is the facing
   * itself and never the mirror: the renderer mirrors a station facing right.
   * The claim used to be the other way round, unverified since #131 flagged it,
   * and the whole mine rendered mirrored on the strength of it — the art is
   * measured now, in lib/sprite/sheetFacing.test.ts.
   *
   * DATA, never re-derived at render time (#153): the maintainer authored an
   * arrow on every workstation across all five tier panels, and
   * \`docs/mine-interior-facing.json\` is that sheet transcribed. Stations the
   * sheet does not author — the three foreman spots and the corridor features —
   * take the generator's own derivation instead: a station sits beside a
   * corridor and turns AWAY from it, into the rock it is picking.
   *
   * What this replaces is \`facesLeft = x > 50\`, "face the middle of the shaft",
   * which agreed with the authored sheet on five of the eighteen workers.
   */
  facesLeft: boolean
}

/** A junction or endpoint of the passable-path network. */
export interface RouteNode extends InteriorPoint {
  id: number
}

/**
 * One corridor between two junctions, as the ordered points the gray route line
 * actually passes through — a polyline, not a straight line, so a dwarf walking
 * it follows the painted stair rather than cutting through the rock.
 */
export interface RouteEdge {
  from: number
  to: number
  points: readonly InteriorPoint[]
  /**
   * True for the one edge that was not extracted: the seam joining the
   * entrance stub to the main network, which the route mask reports as a
   * separate component only because the painted entrance decoration covers the
   * pixels that connect them (docs/map-coordinates.md §3.2).
   */
  bridged?: boolean
}
`)

  lines.push(`
/**
 * The panel box \`docs/mine-interior-features.json\` measured its own
 * percentages against, and where inside it that panel draws the painting.
 *
 * Carried here so the bridge is checkable from the data rather than only from
 * the generator: \`interiorMap.test.ts\` re-derives every coordinate below from
 * the committed dataset through these two boxes, so a hand-edited number and a
 * stale regeneration both fail loudly.
 */
export const PANEL_BOX = { width: ${PANEL_BOX.width}, height: ${PANEL_BOX.height} } as const

/**
 * The pixel size of the painting these percentages are percentages OF — the
 * five \`inside-mines/inside-<tier>-mine.jpg\` files, which share it (Cropper is
 * 2px shorter, 0.06%, and shares the map like the rest).
 *
 * A deliberate copy of \`art.ts\`'s \`INTERIOR_ART_SIZE\`, kept here because a
 * coordinate space belongs with the coordinates: this module is authored
 * against the painting, and reading its own ratio out of the art barrel would
 * make the map depend on the bundler. \`interiorMap.test.ts\` holds the two
 * equal, so the copy cannot drift unnoticed.
 */
export const INTERIOR_PAINTING_SIZE = { width: ${PAINTING_SIZE.width}, height: ${PAINTING_SIZE.height} } as const

export const PANEL_ART_BOX = {
  x: ${PANEL_ART_BOX.x},
  y: ${PANEL_ART_BOX.y},
  width: ${PANEL_ART_BOX.width},
  height: ${PANEL_ART_BOX.height}
} as const

/** Every marker the design's work-point sheet draws, re-anchored to the painting. */
export const INTERIOR_STATIONS: readonly InteriorStation[] = [`)
  for (const station of stations) {
    lines.push(
      `  { id: '${station.id}', kind: '${station.kind}', x: ${station.x}, y: ${station.y},` +
        ` facesLeft: ${station.facesLeft} },`
    )
  }
  lines.push(`]
`)

  lines.push(`
/** The junctions and endpoints of the passable-path network. */
export const INTERIOR_ROUTE_NODES: readonly RouteNode[] = [`)
  for (const node of route.nodes) {
    lines.push(`  { id: ${node.id}, x: ${node.x}, y: ${node.y} },`)
  }
  lines.push(`]
`)

  lines.push(`
/** The corridors between them, each carrying the shape of its own stretch. */
export const INTERIOR_ROUTE_EDGES: readonly RouteEdge[] = [`)
  for (const edge of route.edges) {
    const points = edge.points.map(formatPoint).join(', ')
    const bridged = edge.bridged === true ? ', bridged: true' : ''
    lines.push(`  { from: ${edge.from}, to: ${edge.to}, points: [${points}]${bridged} },`)
  }
  lines.push(`]`)

  /*
   * Formatted before it is written, not after. `pnpm format:check` runs in CI
   * over every tracked file, so a generator whose output prettier disagrees
   * with makes "regenerate the map" and "the build is green" mutually
   * exclusive — and the person who hits it has no way to tell which of the two
   * is wrong.
   */
  const formatted = await prettier.format(lines.join('\n') + '\n', {
    ...(await prettier.resolveConfig(TARGET)),
    parser: 'typescript'
  })
  writeFileSync(TARGET, formatted, 'utf8')

  const counts = STATION_KINDS.map(
    (kind) => `${kind} ${stations.filter((s) => s.kind === kind).length}`
  ).join(', ')
  process.stdout.write(
    `wrote ${TARGET}\n  stations: ${counts}\n` +
      `  route: ${route.nodes.length} nodes, ${route.edges.length} edges ` +
      `(stub bridged across ${Math.round(route.bridgeSpan)}px of the painting)\n`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await build()
}
