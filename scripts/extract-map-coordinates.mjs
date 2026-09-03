#!/usr/bin/env node
/**
 * Extracts machine-readable coordinates from the DwarfAI-Miners design
 * source's annotated PNGs — the data gap issues #90 and #89 name: the 74
 * world-map spawn points and the mine-interior work points/ladders/ramps/
 * paths exist only as pixels in the Canva exports, with no coordinate list
 * anywhere. Run it with the local design folder as the one required
 * argument (never hardcoded, and never committed — see docs/map-coordinates.md):
 *
 *   node scripts/extract-map-coordinates.mjs <design-assets-dir> [--overlay-dir <dir>]
 *
 * `<design-assets-dir>` is the `assets/` folder of the design source (the
 * directory containing `map/map-mine-spawn-points.png` and
 * `mine/maps/mine-interior-*.png`). `--overlay-dir`, if given, gets the
 * validation overlay PNGs this script renders — point it at a scratch
 * directory, never into the repo: the overlays are derived from gitignored
 * design assets and must not be committed.
 *
 * Method (see docs/map-coordinates.md for the full report):
 *   1. Decode each source PNG with the from-scratch codec in
 *      scripts/mapCoords/png.mjs (no new dependency: Node's own zlib does
 *      DEFLATE, everything PNG-shaped is implemented there).
 *   2. Every point-shaped annotation (spawn/worker/foreman/ladder/ramp) is a
 *      flat design-tool fill color with no gradient — scripts/mapCoords/cluster.mjs
 *      finds every connected blob within a tight color tolerance and reduces
 *      each to a centroid. One blob is one marker; verified per class by
 *      comparing the blob count to what screens/map.md and screens/mine.md
 *      describe, and by the rendered overlay.
 *   3. The gray route line is a shape, not a point: scripts/mapCoords/skeleton.mjs
 *      thins it to a 1px skeleton, walks it as a graph, merges thinning-
 *      corner artifacts, and splices out plain bends so only true branch
 *      points remain as nodes — see that file's header for why.
 *   4. Every coordinate is normalized to a percentage of the image pixels it
 *      was measured against and rounded to two decimals — see each dataset's
 *      own `_meta.convention` field, and read .claude/rules/coordinates.md
 *      before treating either output as one of this repo's two existing
 *      coordinate conventions. They are neither: they are raw extraction
 *      space, one re-anchoring step away from being useful to `mapSites.ts`
 *      or `sceneLayout.ts`.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodePng, encodePng } from './mapCoords/png.mjs'
import { colorMask, connectedComponents, findMarkers } from './mapCoords/cluster.mjs'
import {
  thinToSkeleton,
  traceSkeletonGraph,
  mergeCloseNodes,
  spliceDegreeTwoNodes,
  renumberComponent,
  simplifyPolyline
} from './mapCoords/skeleton.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS_DIR = join(REPO_ROOT, 'docs')

const MARKER_COLORS = {
  spawn: [255, 49, 49],
  worker: [81, 112, 255],
  foreman: [255, 117, 31],
  ladder: [140, 82, 255],
  ramp: [255, 0, 176]
}
const ROUTE_COLOR = [166, 166, 166]

/** Displayed left-to-right column order in both interior comparison sheets. */
const PANEL_LABELS = ['Cropper', 'Bronze', 'Silver', 'Gold', 'Uranium']
/**
 * Which panel's markers/route become the committed dataset. Every panel
 * encodes the same symmetric logical map (screens/mine.md), so any one
 * would do topologically — Bronze is picked because it is the only panel
 * whose route extraction needed zero manual exception: Cropper and Silver's
 * own ore-glint palettes sit close enough to the flat route gray (166,166,166)
 * to add a few extra thinning-graph nodes (see the report's route section).
 */
const EXTRACTED_PANEL_INDEX = 1

function round2(n) {
  return Math.round(n * 100) / 100
}

function toPercent(x, y, width, height) {
  return { xPercent: round2((x / width) * 100), yPercent: round2((y / height) * 100) }
}

function readDesignPng(designDir, relativePath) {
  const fullPath = join(designDir, relativePath)
  const buffer = readFileSync(fullPath)
  return { buffer, bitmap: decodePng(buffer), fileName: relativePath.split(/[\\/]/).pop() }
}

/** Render `bitmap` cropped to a box, with markers overlaid, as a validation PNG. */
function renderOverlay(bitmap, box, draw) {
  const { rgba, width } = bitmap
  const { x: bx, y: by, width: bw, height: bh } = box
  const overlay = new Uint8Array(bw * bh * 4)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const si = ((by + y) * width + (bx + x)) * 4
      const di = (y * bw + x) * 4
      overlay[di] = rgba[si]
      overlay[di + 1] = rgba[si + 1]
      overlay[di + 2] = rgba[si + 2]
      overlay[di + 3] = 255
    }
  }
  const plot = (x, y, color) => {
    const xi = Math.round(x) - bx
    const yi = Math.round(y) - by
    if (xi < 0 || xi >= bw || yi < 0 || yi >= bh) return
    const di = (yi * bw + xi) * 4
    overlay[di] = color[0]
    overlay[di + 1] = color[1]
    overlay[di + 2] = color[2]
  }
  const plotSquare = (x, y, r, color) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) plot(x + dx, y + dy, color)
  }
  const line = (x0, y0, x1, y1, color) => {
    x0 = Math.round(x0)
    y0 = Math.round(y0)
    x1 = Math.round(x1)
    y1 = Math.round(y1)
    const dx = Math.abs(x1 - x0)
    const sx = x0 < x1 ? 1 : -1
    const dy = -Math.abs(y1 - y0)
    const sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      plot(x0, y0, color)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        x0 += sx
      }
      if (e2 <= dx) {
        err += dx
        y0 += sy
      }
    }
  }
  draw({ plot, plotSquare, line })
  return encodePng({ width: bw, height: bh, rgba: overlay })
}

// ---------------------------------------------------------------------------
// World map spawn points
// ---------------------------------------------------------------------------

function extractSpawnPoints(designDir) {
  const { bitmap, fileName } = readDesignPng(designDir, join('map', 'map-mine-spawn-points.png'))
  const { width, height } = bitmap
  const TOLERANCE = 40
  const MIN_SIZE = 20
  const blobs = findMarkers(bitmap, MARKER_COLORS.spawn, TOLERANCE, MIN_SIZE)

  const points = blobs
    .map((b) => ({
      pixel: { x: round2(b.centroid.x), y: round2(b.centroid.y) },
      ...toPercent(b.centroid.x, b.centroid.y, width, height),
      blobSizePx: b.size
    }))
    .sort((a, b) => a.pixel.y - b.pixel.y || a.pixel.x - b.pixel.x)
    .map((p, i) => ({ id: i + 1, ...p }))

  const data = {
    _meta: {
      sourceImage: fileName,
      sourceImagePixelSize: { width, height },
      extractedAt: new Date().toISOString().slice(0, 10),
      extractor: 'scripts/extract-map-coordinates.mjs',
      convention:
        "image-percent: xPercent/yPercent are each point's position as a percentage of " +
        "this source PNG's own pixel dimensions (origin top-left). This is NOT " +
        "mapSites.ts's box-percent (percentage of the rendered map box, see " +
        '.claude/rules/coordinates.md) and this source PNG is a full app-mockup screenshot ' +
        '(gold card border, corner radius, and UI chrome included) rather than a pixel-identical ' +
        "crop of the renderer's actual map-bg-*.jpg art — see docs/map-coordinates.md before " +
        'authoring MINE_SITES from these numbers.',
      markerColor: 'rgb(255, 49, 49)',
      colorTolerance: TOLERANCE,
      minBlobSizePx: MIN_SIZE,
      count: { found: points.length, expected: 74 }
    },
    spawnPoints: points
  }

  const overlayPng = renderOverlay(bitmap, { x: 0, y: 0, width, height }, ({ plotSquare }) => {
    for (const p of points) plotSquare(p.pixel.x, p.pixel.y, 3, [0, 255, 255])
  })

  return { data, overlayPng, bitmap }
}

// ---------------------------------------------------------------------------
// Mine-interior work points (spawn/worker/foreman/ladder/ramp)
// ---------------------------------------------------------------------------

function extractInteriorMarkers(designDir) {
  const { bitmap, fileName } = readDesignPng(
    designDir,
    join('mine', 'maps', 'mine-interior-work-points.png')
  )
  const { width, height } = bitmap
  const panelWidth = width / PANEL_LABELS.length
  const TOLERANCE = 40
  const MIN_SIZE = 80

  const markers = {}
  const counts = {}
  for (const [className, color] of Object.entries(MARKER_COLORS)) {
    const blobs = findMarkers(bitmap, color, TOLERANCE, MIN_SIZE)
    const perPanelCounts = PANEL_LABELS.map(() => 0)
    for (const b of blobs) {
      const panelIndex = Math.min(PANEL_LABELS.length - 1, Math.floor(b.centroid.x / panelWidth))
      perPanelCounts[panelIndex]++
    }
    counts[className] = {
      totalFound: blobs.length,
      perPanel: Object.fromEntries(PANEL_LABELS.map((label, i) => [label, perPanelCounts[i]]))
    }

    const panelBlobs = blobs
      .filter((b) => Math.floor(b.centroid.x / panelWidth) === EXTRACTED_PANEL_INDEX)
      .map((b) => {
        const localX = b.centroid.x - EXTRACTED_PANEL_INDEX * panelWidth
        return {
          pixel: { x: round2(localX), y: round2(b.centroid.y) },
          ...toPercent(localX, b.centroid.y, panelWidth, height),
          blobSizePx: b.size
        }
      })
      .sort((a, b) => a.pixel.y - b.pixel.y || a.pixel.x - b.pixel.x)
      .map((p, i) => ({ id: i + 1, ...p }))

    markers[className] = panelBlobs
  }

  const panelBox = {
    x: EXTRACTED_PANEL_INDEX * panelWidth,
    y: 0,
    width: panelWidth,
    height
  }
  // A same-color square would just repaint the marker and prove nothing; a
  // contrasting crosshair independently shows whether the centroid actually
  // landed in the middle of each shape.
  const CROSSHAIR = [255, 255, 255]
  const overlayPng = renderOverlay(bitmap, panelBox, ({ plot, plotSquare }) => {
    for (const points of Object.values(markers)) {
      for (const p of points) {
        const x = panelBox.x + p.pixel.x
        const y = p.pixel.y
        plotSquare(x, y, 1, [0, 0, 0])
        for (let d = -4; d <= 4; d++) {
          plot(x + d, y, CROSSHAIR)
          plot(x, y + d, CROSSHAIR)
        }
      }
    }
  })

  return { fileName, width, height, panelWidth, markers, counts, overlayPng, bitmap }
}

// ---------------------------------------------------------------------------
// Mine-interior passable paths (gray route line -> polyline graph)
// ---------------------------------------------------------------------------

function extractRouteComponent(bitmap, mask, blob, panelBox) {
  const { width } = bitmap
  const { minX, minY, maxX, maxY } = blob.bbox
  const pad = 2
  const bx = Math.max(panelBox.x, minX - pad)
  const by = Math.max(0, minY - pad)
  const bw = Math.min(panelBox.x + panelBox.width, maxX + pad + 1) - bx
  const bh = Math.min(panelBox.height, maxY + pad + 1) - by

  const subMask = new Uint8Array(bw * bh)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (mask[(by + y) * width + (bx + x)] === 1) subMask[y * bw + x] = 1
    }
  }

  const skeleton = thinToSkeleton(subMask, bw, bh)
  const graph = traceSkeletonGraph(skeleton, bw, bh)
  const merged = mergeCloseNodes(graph.nodes, graph.edges, 6)
  const spliced = spliceDegreeTwoNodes(merged.nodes, merged.edges)
  const renumbered = renumberComponent(spliced.nodes, spliced.edges)

  const toLocal = (x, y) => {
    const gx = bx + x - panelBox.x
    const gy = by + y
    return {
      pixel: { x: round2(gx), y: round2(gy) },
      ...toPercent(gx, gy, panelBox.width, panelBox.height)
    }
  }

  const nodes = renumbered.nodes.map((n) => ({ id: n.id, ...toLocal(n.x, n.y) }))
  const edges = renumbered.edges.map((e) => {
    const simplified = simplifyPolyline(e.points, 1.5)
    return {
      from: e.from,
      to: e.to,
      points: simplified.map((p) => toLocal(p.x, p.y))
    }
  })

  return {
    nodes,
    edges,
    skeletonPixelCount: skeleton.reduce((s, v) => s + v, 0),
    bbox: { bx, by, bw, bh },
    skeleton
  }
}

function extractInteriorPaths(designDir, panelWidth, height) {
  const { bitmap, fileName } = readDesignPng(
    designDir,
    join('mine', 'maps', 'mine-interior-passable-paths.png')
  )
  const { width } = bitmap
  const TOLERANCE = 30
  const MIN_SIZE = 100
  const mask = colorMask(bitmap, ROUTE_COLOR, TOLERANCE)
  const allBlobs = connectedComponents(mask, width, height, MIN_SIZE)

  const panelBox = { x: EXTRACTED_PANEL_INDEX * panelWidth, y: 0, width: panelWidth, height }
  const panelBlobs = allBlobs
    .filter((b) => b.centroid.x >= panelBox.x && b.centroid.x < panelBox.x + panelBox.width)
    .sort((a, b) => b.size - a.size)

  const network = extractRouteComponent(bitmap, mask, panelBlobs[0], panelBox)
  const stub = panelBlobs[1] ? extractRouteComponent(bitmap, mask, panelBlobs[1], panelBox) : null

  // Cross-panel consistency check, reported honestly rather than assumed.
  const perPanelTopology = PANEL_LABELS.map((label, i) => {
    const box = { x: i * panelWidth, y: 0, width: panelWidth, height }
    const blobsHere = allBlobs
      .filter((b) => b.centroid.x >= box.x && b.centroid.x < box.x + box.width)
      .sort((a, b) => b.size - a.size)
    if (blobsHere.length === 0) return { label, nodes: 0, edges: 0, blobSizes: [] }
    const net = extractRouteComponent(bitmap, mask, blobsHere[0], box)
    return {
      label,
      nodes: net.nodes.length,
      edges: net.edges.length,
      blobSizes: blobsHere.map((b) => b.size)
    }
  })

  const overlayPng = renderOverlay(bitmap, panelBox, ({ plot, plotSquare }) => {
    for (const comp of [network, stub].filter(Boolean)) {
      const { bx, by, bw, bh } = comp.bbox
      const { skeleton } = comp
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          if (skeleton[y * bw + x] === 1) plot(bx + x, by + y, [0, 255, 0])
        }
      }
      for (const n of comp.nodes) plotSquare(panelBox.x + n.pixel.x, n.pixel.y, 2, [255, 0, 0])
    }
  })

  return {
    fileName,
    width,
    height,
    tolerance: TOLERANCE,
    minSize: MIN_SIZE,
    routeColor: 'rgb(166, 166, 166)',
    network: {
      nodes: network.nodes,
      edges: network.edges,
      skeletonPixelCount: network.skeletonPixelCount
    },
    stub: stub
      ? { nodes: stub.nodes, edges: stub.edges, skeletonPixelCount: stub.skeletonPixelCount }
      : null,
    perPanelTopology,
    overlayPng
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const designDir = args[0]
  if (!designDir) {
    console.error(
      'Usage: node scripts/extract-map-coordinates.mjs <design-assets-dir> [--overlay-dir <dir>]'
    )
    process.exit(1)
  }
  const overlayFlagIndex = args.indexOf('--overlay-dir')
  const overlayDir = overlayFlagIndex !== -1 ? args[overlayFlagIndex + 1] : null

  console.log(`Reading design source from ${designDir}`)

  const spawnResult = extractSpawnPoints(designDir)
  console.log(
    `\nWorld map spawn points: found ${spawnResult.data.spawnPoints.length} (expected 74)`
  )

  const interiorMarkers = extractInteriorMarkers(designDir)
  console.log(`\nInterior markers (panel "${PANEL_LABELS[EXTRACTED_PANEL_INDEX]}"):`)
  for (const [className, counts] of Object.entries(interiorMarkers.counts)) {
    console.log(
      `  ${className}: total=${counts.totalFound} perPanel=${JSON.stringify(counts.perPanel)}`
    )
  }

  const interiorPaths = extractInteriorPaths(
    designDir,
    interiorMarkers.panelWidth,
    interiorMarkers.height
  )
  console.log(`\nInterior route (panel "${PANEL_LABELS[EXTRACTED_PANEL_INDEX]}"):`)
  console.log(
    `  network: ${interiorPaths.network.nodes.length} nodes, ${interiorPaths.network.edges.length} edges, ${interiorPaths.network.skeletonPixelCount} skeleton px`
  )
  if (interiorPaths.stub) {
    console.log(
      `  stub: ${interiorPaths.stub.nodes.length} nodes, ${interiorPaths.stub.edges.length} edges, ${interiorPaths.stub.skeletonPixelCount} skeleton px`
    )
  }
  console.log('  per-panel topology (cross-check):')
  for (const p of interiorPaths.perPanelTopology) {
    console.log(
      `    ${p.label}: nodes=${p.nodes} edges=${p.edges} blobSizes=${p.blobSizes.join(',')}`
    )
  }

  const interiorData = {
    _meta: {
      sourceImages: {
        workPoints: interiorMarkers.fileName,
        passablePaths: interiorPaths.fileName
      },
      sourceImagePixelSize: { width: interiorMarkers.width, height: interiorMarkers.height },
      panelsInSource: PANEL_LABELS.length,
      panelLabelsLeftToRight: PANEL_LABELS,
      extractedPanel: PANEL_LABELS[EXTRACTED_PANEL_INDEX],
      extractedPanelIndex: EXTRACTED_PANEL_INDEX,
      panelPixelSize: { width: round2(interiorMarkers.panelWidth), height: interiorMarkers.height },
      extractedAt: new Date().toISOString().slice(0, 10),
      extractor: 'scripts/extract-map-coordinates.mjs',
      convention:
        'image-percent of ONE tier panel (the extractedPanel above): xPercent/yPercent are each ' +
        "point's position as a percentage of that single panel's own pixel box, origin top-left. " +
        'This is the same *kind* of convention sceneLayout.ts uses for the real portrait painting ' +
        '(percent of the image, projected to the rendered box via sceneGeometry.projectToBox — see ' +
        '.claude/rules/coordinates.md) but NOT the same pixel space: this panel is a ' +
        `${Math.round(interiorMarkers.panelWidth)}x${interiorMarkers.height} crop from a 5-panel ` +
        'comparison sheet. INTERIOR_ART_SIZE (src/renderer/src/lib/art.ts) currently points ' +
        'sceneLayout.ts at a 1289x1600 painting that is a DIFFERENT, older concept piece, not this ' +
        "mockup's art — the matching production painting (verified visually, same composition, no " +
        'annotations) is src/renderer/src/assets/art/inside-mines/inside-<tier>-mine.jpg, 1184x3622, ' +
        'not yet wired into any component. Re-anchor against that file (renaming the two that carry ' +
        'typos: inside-cropper-mine..jpg, insiede-uranium-mine.jpg) before authoring sceneLayout.ts ' +
        'anchors from these numbers — see docs/map-coordinates.md §4.',
      markerColors: {
        spawn: 'rgb(255, 49, 49)',
        worker: 'rgb(81, 112, 255)',
        foreman: 'rgb(255, 117, 31)',
        ladder: 'rgb(140, 82, 255)',
        ramp: 'rgb(255, 0, 176)'
      },
      routeColor: interiorPaths.routeColor,
      counts: interiorMarkers.counts
    },
    markers: interiorMarkers.markers,
    paths: {
      network: interiorPaths.network,
      stub: interiorPaths.stub
    }
  }

  await mkdir(DOCS_DIR, { recursive: true })
  await writeFile(
    join(DOCS_DIR, 'map-spawn-points.json'),
    JSON.stringify(spawnResult.data, null, 2) + '\n'
  )
  await writeFile(
    join(DOCS_DIR, 'mine-interior-features.json'),
    JSON.stringify(interiorData, null, 2) + '\n'
  )
  console.log('\nWrote docs/map-spawn-points.json and docs/mine-interior-features.json')

  if (overlayDir) {
    await mkdir(overlayDir, { recursive: true })
    await writeFile(join(overlayDir, 'overlay-map-spawn-points.png'), spawnResult.overlayPng)
    await writeFile(join(overlayDir, 'overlay-interior-markers.png'), interiorMarkers.overlayPng)
    await writeFile(join(overlayDir, 'overlay-interior-paths.png'), interiorPaths.overlayPng)
    console.log(`Wrote validation overlays to ${overlayDir}`)
  }
}

await main()
