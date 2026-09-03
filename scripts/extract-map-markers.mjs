/**
 * Read the two numbers the world map needs out of the verified design exports
 * (#136): the five mine-marker colours, and where the map artwork sits inside
 * the mockup screenshot the 74 spawn points were measured on.
 *
 * Both are measurements, not readings off a screen. `foundations.md` states the
 * five marker families by name (Bronze cyan, Cropper orange-brown, Silver grey,
 * Gold yellow, Uranium green) and explicitly does NOT give hex values, and
 * `docs/map-coordinates.md` §4 says the spawn percentages are percentages of a
 * full app-mockup screenshot — gold card frame and icon column included — so
 * they have to be re-anchored against the artwork's own pixel space before a
 * renderer can use them. Eyeballing either one produces a number nobody can
 * reproduce when the art is revised; this script produces both again.
 *
 *   node scripts/extract-map-markers.mjs <design-assets-dir>
 *
 * `<design-assets-dir>` is the design source's `assets/` folder, passed in and
 * never hardcoded — it is gitignored local material, and its path must not be
 * committed anywhere (see skills/privacy-guard/SKILL.md). No new dependency:
 * PNG decoding is scripts/mapCoords/png.mjs, the same from-scratch codec the
 * coordinate extraction uses.
 *
 * ## How the marker colours are found
 *
 * A marker is drawn as a FLAT fill, so it is the one thing on a hand-painted
 * map that is a large run of a single exact RGB value in a compact 10px box.
 * That is the whole detector: exact-colour connected components, keeping those
 * that are big (>= 40px), small-boxed (<= 14px on both axes) and solid (over
 * 55% of their bounding box). No seed position is supplied and no colour is
 * looked for, so the five that come out are not five this script went hunting
 * for — which is the difference between a measurement and a confirmation.
 *
 * ## How the card interior is found
 *
 * The design's map container has a `2px #fae2b6` border (`screens/map.md`), and
 * the mockup renders it: every scanline crosses gold frame, then that cream
 * border, then artwork. The interior edge is the first pixel on each scanline
 * that is neither, taken as a median over many scanlines so one cloud or one
 * rounded corner cannot move it.
 */
import { readFileSync } from 'node:fs'
import { decodePng } from './mapCoords/png.mjs'

/** The design's cream border, from `foundations.md`'s colour table. */
const CREAM = [0xfa, 0xe2, 0xb6]
/** The mockup's own card frame. Not a product colour — it is the screenshot's chrome. */
const FRAME = [0xd1, 0x98, 0x31]
/** How far a pixel may sit from cream or gold and still count as border. */
const BORDER_TOLERANCE = 42

/** Smallest run of one exact colour that can be a marker rather than flat art. */
const MIN_MARKER_PX = 40
/** A 10px marker cannot have a bounding box wider or taller than this. */
const MAX_MARKER_BOX = 14
/** Share of its own bounding box a marker fills; a streak of sky does not. */
const MIN_MARKER_FILL = 0.55

function main() {
  const assetsDir = process.argv[2]
  if (assetsDir === undefined) {
    console.error('usage: node scripts/extract-map-markers.mjs <design-assets-dir>')
    process.exit(2)
  }

  const markers = decodePng(readFileSync(`${assetsDir}/map/map-mine-markers.png`))
  const spawnSheet = decodePng(readFileSync(`${assetsDir}/map/map-mine-spawn-points.png`))

  console.log(`marker export: ${markers.width}x${markers.height}`)
  for (const blob of flatDiscs(markers)) {
    console.log(
      `  ${toHex(blob.colour)}  rgb(${blob.colour.join(', ')})  ` +
        `${blob.size}px box ${blob.box.join('x')} at ${blob.centroid.map((v) => v.toFixed(2)).join(', ')}`
    )
  }

  console.log(`\nspawn-point export: ${spawnSheet.width}x${spawnSheet.height}`)
  const rect = cardInterior(spawnSheet)
  const width = rect.x1 - rect.x0
  const height = rect.y1 - rect.y0
  console.log(`  artwork interior: x ${rect.x0}..${rect.x1}, y ${rect.y0}..${rect.y1}`)
  console.log(`  size ${width}x${height}, aspect ${(width / height).toFixed(5)}`)
}

/**
 * Every compact solid run of one exact colour, largest first.
 *
 * Exact equality rather than a tolerance: an antialiased edge pixel is a
 * DIFFERENT colour from the fill it borders, so equality gives the marker's own
 * authored value and never an average of it with the map underneath.
 */
function flatDiscs(bitmap) {
  const { width, height } = bitmap
  const visited = new Uint8Array(width * height)
  const found = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (visited[y * width + x] === 1) continue
      const blob = growExactRun(bitmap, visited, x, y)
      const [boxWidth, boxHeight] = blob.box
      if (blob.size < MIN_MARKER_PX) continue
      if (boxWidth > MAX_MARKER_BOX || boxHeight > MAX_MARKER_BOX) continue
      if (blob.size / (boxWidth * boxHeight) < MIN_MARKER_FILL) continue
      found.push(blob)
    }
  }
  return found.sort((a, b) => b.size - a.size)
}

/** Flood one connected run of pixels sharing the seed's exact colour. */
function growExactRun(bitmap, visited, seedX, seedY) {
  const { width, height } = bitmap
  const colour = pixelAt(bitmap, seedX, seedY)
  const stack = [[seedX, seedY]]
  let size = 0
  let sumX = 0
  let sumY = 0
  let minX = seedX
  let maxX = seedX
  let minY = seedY
  let maxY = seedY

  while (stack.length > 0) {
    const [x, y] = stack.pop()
    if (x < 0 || y < 0 || x >= width || y >= height) continue
    const index = y * width + x
    if (visited[index] === 1) continue
    const here = pixelAt(bitmap, x, y)
    if (here[0] !== colour[0] || here[1] !== colour[1] || here[2] !== colour[2]) continue
    visited[index] = 1
    size++
    sumX += x
    sumY += y
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
  }

  return {
    colour,
    size,
    box: [maxX - minX + 1, maxY - minY + 1],
    centroid: [sumX / size, sumY / size]
  }
}

/**
 * The rectangle of ARTWORK inside the mockup's card, in mockup pixels.
 *
 * Scanned from all four sides and reduced with a median so the rounded corners,
 * the overlaid totals chip and any cloud that happens to be cream-coloured
 * cannot pull an edge. The bounds are the first artwork pixel and the last one,
 * so the interior width is x1 - x0 + 1 pixel centres apart; callers wanting the
 * continuous span add the half pixel at each end themselves.
 */
function cardInterior(bitmap) {
  const { width, height } = bitmap
  const rows = sampleLines(height)
  const columns = sampleLines(width)

  const lefts = rows.map((y) => scanLine(bitmap, y, 0, 1, true))
  const rights = rows.map((y) => scanLine(bitmap, y, width - 1, -1, true))
  const tops = columns.map((x) => scanLine(bitmap, x, 0, 1, false))
  const bottoms = columns.map((x) => scanLine(bitmap, x, height - 1, -1, false))

  return {
    x0: median(lefts),
    x1: median(rights),
    y0: median(tops),
    y1: median(bottoms)
  }
}

/** Evenly spaced lines across the middle 80%, so no sample sits in a corner. */
function sampleLines(span) {
  const first = Math.round(span * 0.1)
  const last = Math.round(span * 0.9)
  const lines = []
  for (let value = first; value <= last; value += 4) lines.push(value)
  return lines
}

/**
 * Walk in from one edge and report the first artwork pixel.
 *
 * The frame has to be CROSSED first, not merely skipped: outside the card the
 * mockup is a white page and an icon column, and both are "neither frame nor
 * cream" — a scan that reported the first such pixel would answer with the page
 * margin on the right and bottom edges, where the card does not run to the edge
 * of the screenshot. So nothing counts until the gold frame has been entered.
 */
function scanLine(bitmap, fixed, start, step, horizontal) {
  const limit = horizontal ? bitmap.width : bitmap.height
  let insideFrame = false
  for (let moving = start; moving >= 0 && moving < limit; moving += step) {
    const [x, y] = horizontal ? [moving, fixed] : [fixed, moving]
    const pixel = pixelAt(bitmap, x, y)
    if (near(pixel, FRAME) || near(pixel, CREAM)) {
      insideFrame = true
      continue
    }
    if (insideFrame) return moving
  }
  return start
}

function near(pixel, target) {
  return (
    Math.hypot(pixel[0] - target[0], pixel[1] - target[1], pixel[2] - target[2]) <= BORDER_TOLERANCE
  )
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function pixelAt(bitmap, x, y) {
  const index = (y * bitmap.width + x) * 4
  return [bitmap.rgba[index], bitmap.rgba[index + 1], bitmap.rgba[index + 2]]
}

function toHex(colour) {
  return `#${colour.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

main()
