#!/usr/bin/env node
/**
 * Builds every application icon DwarfAI-Miners ships from one source: the
 * painted gold mound (src/renderer/src/assets/art/mound-gold.png), which is
 * already chroma-keyed to transparency and trimmed tight to its silhouette by
 * scripts/build-art.mjs. Run it with `pnpm icons`.
 *
 * The mound alone is too fussy to read at 16x16 (fine ore highlights, a
 * timber frame, rail ties), so it is composited centered on a dark circular
 * badge first: a strong, high-contrast silhouette against a plain backdrop is
 * what actually survives being shrunk to a taskbar or tray size. The badge
 * math lives in scripts/art/badge.mjs, unit tested on its own; this file is
 * the thin, untested glue that turns it into files (same split as
 * scripts/build-art.mjs + scripts/art/keying.mjs).
 *
 * Outputs, all derived from one 1024x1024 composite so every size is
 * downscaled rather than re-rendered:
 *
 *   build/icon.ico       Windows installer + exe icon (electron-builder's
 *                        default `build/` resource dir). Multi-size (16
 *                        through 256) via png2icons.
 *   build/icon.icns       macOS target icon, same source, via png2icons.
 *   build/icon.png        512x512, Linux target icon.
 *   resources/tray-icon.png      16x16 base tray icon (see src/main/tray.ts).
 *   resources/tray-icon@2x.png   32x32 — Electron's nativeImage picks this up
 *                                automatically on HiDPI via the "@2x" suffix
 *                                convention when loaded from a file path.
 *   resources/app-icon.png       256x256 BrowserWindow `icon` (Windows/Linux;
 *                                macOS ignores that option). Lives under
 *                                resources/ rather than build/ because
 *                                build/ is a build-time-only input to
 *                                electron-builder — it is never copied into
 *                                the packaged app — while resources/ is
 *                                (see build.extraResources in package.json).
 *
 * Nothing here reads the clock, the RNG, or anything else non-deterministic,
 * so running this twice in a row byte-for-byte reproduces every output file.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Jimp } from 'jimp'
import png2icons from 'png2icons'
import { badgeAlpha, badgeColor, centerOffset, scaleToWidth } from './art/badge.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_ART = join(REPO_ROOT, 'src', 'renderer', 'src', 'assets', 'art', 'mound-gold.png')
const BUILD_DIR = join(REPO_ROOT, 'build')
const RESOURCES_DIR = join(REPO_ROOT, 'resources')

/** The master composite everything else is downscaled from. */
const CANVAS_SIZE = 1024
/** Transparent margin left around the badge circle at the canvas edge. */
const BADGE_MARGIN = 32
const BADGE_RADIUS = CANVAS_SIZE / 2 - BADGE_MARGIN
/** How many pixels either side of the radius the circular edge is softened over. */
const BADGE_FEATHER = 10
/** Dark, warm badge gradient — reads as a cave mouth behind the gold mound. */
const BADGE_CENTER_COLOR = [0x26, 0x1c, 0x10]
const BADGE_EDGE_COLOR = [0x0d, 0x09, 0x05]
/** Fraction of the canvas width the mound art occupies, leaving a visible badge ring. */
const ART_SCALE = 0.74

/** Paint the circular badge directly into a transparent Jimp canvas, in place. */
function paintBadge(canvas) {
  const { data, width, height } = canvas.bitmap
  const cx = width / 2
  const cy = height / 2
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const distance = Math.sqrt(dx * dx + dy * dy)
      const [red, green, blue] = badgeColor(
        distance,
        BADGE_RADIUS,
        BADGE_CENTER_COLOR,
        BADGE_EDGE_COLOR
      )
      data[index] = red
      data[index + 1] = green
      data[index + 2] = blue
      data[index + 3] = badgeAlpha(distance, BADGE_RADIUS, BADGE_FEATHER)
    }
  }
}

/** The 1024x1024 badge + centered mound composite every output is scaled from. */
async function composeMaster() {
  const canvas = new Jimp({ width: CANVAS_SIZE, height: CANVAS_SIZE, color: 0x00000000 })
  paintBadge(canvas)

  const art = await Jimp.read(SOURCE_ART)
  const { width, height } = scaleToWidth(
    art.bitmap.width,
    art.bitmap.height,
    Math.round(CANVAS_SIZE * ART_SCALE)
  )
  art.resize({ w: width, h: height })
  canvas.composite(art, centerOffset(CANVAS_SIZE, width), centerOffset(CANVAS_SIZE, height))
  return canvas
}

/** Downscale a clone of `master` to `size`x`size` and write it as a PNG. */
async function writePng(master, size, path) {
  const resized = master.clone().resize({ w: size, h: size })
  const buffer = await resized.getBuffer('image/png')
  await writeFile(path, buffer)
  return buffer
}

async function main() {
  await mkdir(BUILD_DIR, { recursive: true })
  await mkdir(RESOURCES_DIR, { recursive: true })

  const master = await composeMaster()
  const masterBuffer = await master.getBuffer('image/png')

  await writePng(master, 512, join(BUILD_DIR, 'icon.png'))
  await writePng(master, 16, join(RESOURCES_DIR, 'tray-icon.png'))
  await writePng(master, 32, join(RESOURCES_DIR, 'tray-icon@2x.png'))
  await writePng(master, 256, join(RESOURCES_DIR, 'app-icon.png'))

  // usePNG + forWinExe=true is png2icons' recommended combination for an exe
  // icon: the four smallest sizes stay BMP for the widest compatibility,
  // everything from 64px up is PNG-compressed.
  const icoBuffer = png2icons.createICO(masterBuffer, png2icons.BICUBIC2, 0, true, true)
  if (!icoBuffer) throw new Error('png2icons failed to build icon.ico')
  await writeFile(join(BUILD_DIR, 'icon.ico'), icoBuffer)

  const icnsBuffer = png2icons.createICNS(masterBuffer, png2icons.BICUBIC2, 0)
  if (!icnsBuffer) throw new Error('png2icons failed to build icon.icns')
  await writeFile(join(BUILD_DIR, 'icon.icns'), icnsBuffer)

  console.log(`Wrote icon.ico, icon.icns, icon.png to ${BUILD_DIR}`)
  console.log(`Wrote tray-icon.png, tray-icon@2x.png, app-icon.png to ${RESOURCES_DIR}`)
}

await main()
