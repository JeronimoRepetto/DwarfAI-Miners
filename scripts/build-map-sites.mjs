/**
 * Re-anchor the 74 measured spawn points onto the map artwork, and write them
 * out as renderer data (#136).
 *
 *   node scripts/build-map-sites.mjs
 *
 * Reads `docs/map-spawn-points.json` and writes
 * `src/renderer/src/lib/map/spawnPoints.generated.ts`. Both are committed, and
 * both are in this repository — unlike the coordinate extraction this feeds
 * from, running it needs no design source and no arguments, so anyone can
 * reproduce the committed data on any machine.
 *
 * ## Why a conversion is needed at all
 *
 * `docs/map-coordinates.md` §4 is blunt about it: the JSON's percentages are
 * percentages of `map-mine-spawn-points.png`, which is a full app-mockup
 * SCREENSHOT — gold card frame, rounded corners and the icon column all baked
 * into those pixels — and not of `map-bg-*.jpg`, the painting the renderer
 * actually draws. Copying `xPercent`/`yPercent` straight into the renderer
 * would place every site relative to the mockup's border and icon column.
 *
 * ## The measurement this conversion rests on
 *
 * `scripts/extract-map-markers.mjs` walks in from all four edges of that
 * screenshot, crosses the gold frame and the design's `2px #fae2b6` border, and
 * reports the first and last artwork pixel on each scanline as a median over
 * many scanlines. It answers:
 *
 *     artwork interior: x 25..608, y 19..743   (583x724 between pixel centres)
 *
 * Read as continuous edges — pixel 25 begins at 24.5, pixel 608 ends at 608.5 —
 * that is a 584 x 725 rectangle anchored at (24.5, 18.5), which is what the
 * constants below say.
 *
 * Two independent things say the mockup shows the WHOLE painting rather than a
 * cropped part of it, which is what makes the conversion a straight rescale:
 *
 *  - 584 / 725 = 0.80552, and the artwork's own 1856 / 2304 = 0.80556. Four
 *    parts in a hundred thousand. A `cover` crop of any consequence would show
 *    up here as a ratio difference, and there is none.
 *  - Read side by side, the mockup's night band and `map-bg-nigth.jpg` are the
 *    same painting at the same framing: same moon in the same corner, same
 *    horizon curve, same crater at the lower right, nothing cut off any edge.
 *
 * ## Error budget
 *
 * The extraction claims +/-0.5px on each centroid in mockup pixels (§6), and
 * the interior edges are themselves +/-0.5px, since a scan stops at the first
 * pixel that is no longer clearly border and the pixel before it is a blend.
 * Together that is under +/-0.2% of the painting — about 3 pixels of 1856 — for
 * a marker drawn 10px wide. Percentages are rounded to two decimals, which adds
 * at most 0.005% and is noise next to the above.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'docs', 'map-spawn-points.json')
const OUTPUT = join(ROOT, 'src', 'renderer', 'src', 'lib', 'map', 'spawnPoints.generated.ts')

/**
 * The artwork's rectangle inside the mockup screenshot, in mockup pixels, as
 * continuous edges rather than pixel indices. Measured, not guessed — see the
 * header, and re-measure with `scripts/extract-map-markers.mjs` if the design
 * source is ever re-exported.
 */
const MOCKUP_ARTWORK = { left: 24.5, top: 18.5, width: 584, height: 725 }

function main() {
  const document = JSON.parse(readFileSync(SOURCE, 'utf8'))
  const points = document.spawnPoints
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error(`${SOURCE} carries no spawnPoints`)
  }

  const sites = points.map((point) => ({
    id: point.id,
    x: round2(((point.pixel.x + 0.5 - MOCKUP_ARTWORK.left) / MOCKUP_ARTWORK.width) * 100),
    y: round2(((point.pixel.y + 0.5 - MOCKUP_ARTWORK.top) / MOCKUP_ARTWORK.height) * 100)
  }))

  for (const site of sites) {
    if (site.x < 0 || site.x > 100 || site.y < 0 || site.y > 100) {
      throw new Error(`site ${site.id} landed outside the painting at ${site.x}, ${site.y}`)
    }
  }

  writeFileSync(OUTPUT, render(sites, document), 'utf8')
  console.log(`Wrote ${sites.length} spawn points to ${OUTPUT}`)
}

/** Half-up to two decimals, matching the source document's own rounding. */
function round2(value) {
  return Math.round(value * 100) / 100
}

function render(sites, document) {
  const source = document._meta?.sourceImage ?? 'map-mine-spawn-points.png'
  const rows = sites
    .map((site) => `  { id: ${site.id}, x: ${site.x.toFixed(2)}, y: ${site.y.toFixed(2)} }`)
    .join(',\n')

  return `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by \`node scripts/build-map-sites.mjs\` from
 * \`docs/map-spawn-points.json\` (${sites.length} points measured off the design's
 * \`${source}\` export). That script's header carries the conversion,
 * the measurement it rests on, and the error budget; edit the numbers there,
 * never here.
 *
 * The convention is IMAGE percent — a percentage of the map painting itself,
 * origin top-left — which is neither of the two spaces
 * \`.claude/rules/coordinates.md\` describes and is NOT the source JSON's own
 * percentages either. Project one of these into the rendered box with
 * \`mapProjection.projectToMapBox\` before drawing it.
 */

/** One of the design's spawn locations, in percent of the map painting. */
export interface MapSpawnPoint {
  /**
   * The extraction's own id, 1-based. This is the PERSISTED identity of a site:
   * the projects store remembers this number, so it must stay attached to this
   * position across a regeneration — an id is not an array index, and the order
   * below is only a drawing order.
   */
  id: number
  x: number
  y: number
}

/**
 * The ${sites.length} spawn locations, ordered as the extraction found them: down the
 * painting, farthest first. The order is a drawing order — later markers paint
 * over earlier ones, so a nearer mine overlaps a farther one — and nothing
 * else. Identity is \`id\`.
 *
 * Typed as a non-empty tuple so a caller can take the first point without a
 * runtime guard: a map with no spawn locations is a generation bug, not a state
 * the renderer has to survive.
 */
export const MAP_SPAWN_POINTS: readonly [MapSpawnPoint, ...MapSpawnPoint[]] = [
${rows}
]
`
}

main()
