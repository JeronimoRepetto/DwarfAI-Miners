#!/usr/bin/env node
/**
 * Turns the hand-painted source art into the processed assets the renderer
 * ships. Run it with `pnpm art:build`.
 *
 * The originals are never modified and never enter the repository: they are
 * 20 opaque 2048x2048 JPGs delivered by the product owner and kept outside the
 * tree (see DEFAULT_SOURCE_DIR below). Only the processed output under
 * src/renderer/src/assets/art/ is committed, so a clone builds and runs without
 * the source art present — you only need it to re-run this script.
 *
 * Point it somewhere else with `--src <dir>` or DWARFAI_MINERS_ART_SRC.
 *
 * Three groups, three treatments:
 *
 *   dwarf-*   9 poses of one character on a flat magenta backdrop. Chroma-keyed
 *             to transparency, then cropped to the UNION of all nine content
 *             boxes so every frame shares one canvas and one baseline — that is
 *             what stops the sprite jittering as frames swap. 512px tall PNG.
 *   mound-*   One mine entrance per tier on a flat dark-purple backdrop. Keyed,
 *             trimmed per image with a small margin, 512px wide PNG.
 *   interior-*, map-bg
 *             Opaque painted scenes, nothing to key. Downscaled to 1600px on
 *             the long side and re-encoded as JPEG.
 *
 * The backdrop color differs per image (roughly #FC02FA to #E801D1 across the
 * dwarf poses, around #8C1767 for the mounds), so it is sampled from each
 * image's own four corners rather than hard-coded. Headlamp and ore glows bleed
 * into the backdrop and lose a little of that bleed to the key; what survives
 * is desaturated by the despill instead of staying hot pink, and the app UI is
 * dark enough that the remainder reads as glow.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Jimp } from 'jimp'
import {
  colorDistance,
  contentBox,
  despillMagenta,
  keyAlpha,
  padBox,
  sampleCornerColor,
  spillStrength,
  unionBox
} from './art/keying.mjs'

/**
 * Where the product owner drops the source paintings: the Downloads folder of
 * whoever is running the script. Derived from the home directory rather than
 * hard-coded so the script runs unchanged on macOS and Linux; `--src` or
 * DWARFAI_MINERS_ART_SRC overrides it anywhere.
 */
const DEFAULT_SOURCE_DIR = join(homedir(), 'Downloads', 'DwarfAI-Miners')

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(REPO_ROOT, 'src', 'renderer', 'src', 'assets', 'art')

const TIERS = ['bronze', 'copper', 'silver', 'gold', 'uranium']

/**
 * The raw materials a vault can hold, named for what they actually are rather
 * than for the mine tier that yields them. The two vocabularies are not the
 * same list on purpose: coal has no tier at all (it is the backfill material
 * for tokens burned before the app was installed), and the base tier's ore is
 * iron. src/renderer maps tier to material explicitly; see issue #22.
 *
 * Sources are named `<material>_nugget.jpg` as delivered; the output follows
 * the repo's own `<group>-<variant>` convention.
 */
const NUGGET_MATERIALS = ['iron', 'copper', 'silver', 'gold', 'uranium', 'coal']

/**
 * Every dwarf pose, in the order the union canvas is computed. The names match
 * the frame ids in src/renderer/src/lib/art.ts one for one.
 */
const DWARF_POSES = [
  'dwarf-idle',
  'dwarf-pick-1',
  'dwarf-pick-2',
  'dwarf-walk-1',
  'dwarf-walk-2',
  'dwarf-rest-1',
  'dwarf-rest-2',
  'dwarf-foreman-idle',
  'dwarf-foreman-check'
]

/**
 * Keying constants, tuned against the real paintings: corner samples on this
 * set scatter by at most ~22 units of RGB distance (JPEG noise on a flat fill),
 * so a tolerance of 55 swallows the noise with room to spare while staying far
 * below the ~200 that separates the backdrop from the nearest painted color.
 */
const KEY = {
  tolerance: 55,
  feather: 40,
  spillRadius: 260,
  spillStrength: 0.9
}

/** Sprite frames end up this tall; the shared canvas fixes their width. */
const DWARF_HEIGHT = 512
/** A few pixels of slack around the union box so feathered edges are not clipped. */
const DWARF_MARGIN = 8

/** Mounds end up this wide, height follows their own trimmed aspect ratio. */
const MOUND_WIDTH = 512
const MOUND_MARGIN = 12

/**
 * Nuggets end up this wide. They render around 24px in a pile, so 96 leaves
 * room for HiDPI and for showing one larger in a breakdown without going back
 * to the source. Any bigger is pure download weight for pixels nobody sees.
 */
const NUGGET_WIDTH = 96
const NUGGET_MARGIN = 6

/** Backgrounds: long side and JPEG quality. */
const SCENE_LONG_EDGE = 1600
const SCENE_QUALITY = 82

/**
 * Replace the flat backdrop with transparency, in place.
 *
 * @param {import('jimp').JimpInstance} image
 * @returns {number[]} the key color that was sampled, for the report
 */
function chromaKey(image) {
  const { data } = image.bitmap
  const key = sampleCornerColor(image.bitmap)
  for (let index = 0; index < data.length; index += 4) {
    const pixel = [data[index], data[index + 1], data[index + 2]]
    const distance = colorDistance(pixel, key)
    data[index + 3] = keyAlpha(distance, KEY.tolerance, KEY.feather)
    const strength = spillStrength(distance, KEY.tolerance, KEY.spillRadius, KEY.spillStrength)
    if (strength > 0) {
      const [red, green, blue] = despillMagenta(pixel, strength)
      data[index] = red
      data[index + 1] = green
      data[index + 2] = blue
    }
  }
  return key
}

/** Resize preserving aspect ratio, driven by whichever edge is pinned. */
function resizeTo(image, { width, height }) {
  const source = image.bitmap
  const targetWidth = width ?? Math.max(1, Math.round(source.width * (height / source.height)))
  const targetHeight = height ?? Math.max(1, Math.round(source.height * (width / source.width)))
  image.resize({ w: targetWidth, h: targetHeight })
  return { width: targetWidth, height: targetHeight }
}

/** One line of the end-of-run report. */
function report(rows, name, image, bytes, note = '') {
  rows.push({
    file: name,
    size: `${image.bitmap.width}x${image.bitmap.height}`,
    kb: (bytes / 1024).toFixed(1),
    note
  })
}

async function buildDwarfPoses(sourceDir, rows) {
  const keyed = []
  for (const pose of DWARF_POSES) {
    const image = await Jimp.read(join(sourceDir, `${pose}.jpg`))
    const key = chromaKey(image)
    keyed.push({ pose, image, key, box: contentBox(image.bitmap) })
  }

  const { width, height } = keyed[0].image.bitmap
  for (const { pose, image } of keyed) {
    if (image.bitmap.width !== width || image.bitmap.height !== height) {
      throw new Error(
        `${pose}.jpg is ${image.bitmap.width}x${image.bitmap.height}, expected ${width}x${height} — ` +
          'all poses must share one source canvas for the union crop to line up'
      )
    }
  }

  const union = padBox(unionBox(keyed.map((entry) => entry.box)), DWARF_MARGIN, width, height)
  if (union === null) throw new Error('every dwarf pose keyed to fully transparent — check KEY')

  // One crop box and one target size for all nine, so a frame swap moves
  // nothing but the drawing itself.
  const frameWidth = Math.max(1, Math.round(union.width * (DWARF_HEIGHT / union.height)))
  for (const { pose, image, key } of keyed) {
    image.crop({ x: union.x, y: union.y, w: union.width, h: union.height })
    resizeTo(image, { width: frameWidth, height: DWARF_HEIGHT })
    const buffer = await image.getBuffer('image/png')
    await writeFile(join(OUT_DIR, `${pose}.png`), buffer)
    report(rows, `${pose}.png`, image, buffer.length, `key rgb(${key.map(Math.round).join(',')})`)
  }
  return union
}

async function buildMounds(sourceDir, rows) {
  for (const tier of TIERS) {
    const name = `mound-${tier}`
    const image = await Jimp.read(join(sourceDir, `${name}.jpg`))
    const key = chromaKey(image)
    const { width, height } = image.bitmap
    const box = padBox(contentBox(image.bitmap), MOUND_MARGIN, width, height)
    if (box === null) throw new Error(`${name}.jpg keyed to fully transparent — check KEY`)
    image.crop({ x: box.x, y: box.y, w: box.width, h: box.height })
    resizeTo(image, { width: MOUND_WIDTH })
    const buffer = await image.getBuffer('image/png')
    await writeFile(join(OUT_DIR, `${name}.png`), buffer)
    report(rows, `${name}.png`, image, buffer.length, `key rgb(${key.map(Math.round).join(',')})`)
  }
}

/**
 * One ore nugget per material, keyed off the same magenta backdrop as the
 * dwarf poses. Each is trimmed to its own content box: piles stack these
 * shoulder to shoulder, so shared canvas padding would space them apart with
 * invisible margins instead of letting them touch.
 *
 * A material whose painting has not been delivered yet is skipped with a note
 * rather than failing the run, so the pipeline stays usable while art arrives.
 */
async function buildNuggets(sourceDir, rows) {
  for (const material of NUGGET_MATERIALS) {
    const source = join(sourceDir, `${material}_nugget.jpg`)
    let image
    try {
      image = await Jimp.read(source)
    } catch {
      rows.push({ file: `nugget-${material}.png`, size: '-', kb: '-', note: 'source missing' })
      continue
    }
    const key = chromaKey(image)
    const { width, height } = image.bitmap
    const box = padBox(contentBox(image.bitmap), NUGGET_MARGIN, width, height)
    if (box === null) throw new Error(`${material}_nugget.jpg keyed to fully transparent — check KEY`)
    image.crop({ x: box.x, y: box.y, w: box.width, h: box.height })
    resizeTo(image, { width: NUGGET_WIDTH })
    const buffer = await image.getBuffer('image/png')
    await writeFile(join(OUT_DIR, `nugget-${material}.png`), buffer)
    report(rows, `nugget-${material}.png`, image, buffer.length, `key rgb(${key.map(Math.round).join(',')})`)
  }
}

async function buildScene(sourceDir, rows, name) {
  const image = await Jimp.read(join(sourceDir, `${name}.jpg`))
  const { width, height } = image.bitmap
  const longEdge = Math.max(width, height)
  if (longEdge > SCENE_LONG_EDGE) {
    const scale = SCENE_LONG_EDGE / longEdge
    image.resize({ w: Math.round(width * scale), h: Math.round(height * scale) })
  }
  const buffer = await image.getBuffer('image/jpeg', { quality: SCENE_QUALITY })
  await writeFile(join(OUT_DIR, `${name}.jpg`), buffer)
  report(rows, `${name}.jpg`, image, buffer.length, `q${SCENE_QUALITY}`)
}

function sourceDirFromArgs(argv) {
  const flag = argv.indexOf('--src')
  if (flag !== -1 && argv[flag + 1] !== undefined) return argv[flag + 1]
  return process.env.DWARFAI_MINERS_ART_SRC ?? DEFAULT_SOURCE_DIR
}

async function main() {
  const sourceDir = sourceDirFromArgs(process.argv.slice(2))
  console.log(`Reading source art from ${sourceDir}`)
  await mkdir(OUT_DIR, { recursive: true })

  const rows = []
  const union = await buildDwarfPoses(sourceDir, rows)
  await buildMounds(sourceDir, rows)
  await buildNuggets(sourceDir, rows)
  for (const tier of TIERS) await buildScene(sourceDir, rows, `interior-${tier}`)
  await buildScene(sourceDir, rows, 'map-bg')

  console.log(
    `\nShared dwarf canvas: ${union.width}x${union.height} of the source, ` +
      `cropped at (${union.x}, ${union.y})`
  )
  console.table(rows)
  // Skipped rows carry '-' rather than a size, so they are counted out of both
  // the file count and the total instead of poisoning it with NaN.
  const written = rows.filter((row) => Number.isFinite(Number(row.kb)))
  const total = written.reduce((sum, row) => sum + Number(row.kb), 0)
  const skipped = rows.length - written.length
  console.log(
    `\n${written.length} files written to ${OUT_DIR} (${(total / 1024).toFixed(2)} MB)` +
      (skipped > 0 ? `, ${skipped} skipped for missing sources` : '')
  )
}

await main()
