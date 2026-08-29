/**
 * Pure image math behind the art pipeline (see scripts/build-art.mjs).
 *
 * Every helper works on a plain RGBA bitmap — `{ width, height, data }`, which
 * is exactly the shape of Jimp's `image.bitmap` — so none of this needs Jimp,
 * the filesystem, or a real 2048x2048 painting to be unit tested.
 *
 * @typedef {{ width: number, height: number, data: Uint8Array | Buffer }} Bitmap
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 */

/** Side of the square patch sampled at each corner when guessing the key color. */
export const CORNER_PATCH = 32

/** Alpha at or below which a pixel counts as background when boxing content. */
export const CONTENT_ALPHA = 24

/**
 * Straight Euclidean distance in RGB, alpha ignored. Crude next to a perceptual
 * metric, but the backdrops here are flat and far from the painted subject, and
 * this runs once per pixel over four million of them.
 *
 * @param {readonly number[]} a
 * @param {readonly number[]} b
 * @returns {number}
 */
export function colorDistance(a, b) {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

/**
 * Average the four corner patches to find the backdrop color. The corners are
 * the only region guaranteed to be background in every source painting, and
 * the backdrop differs per image (magenta for the dwarfs, a darker purple for
 * the mounds), so it has to be measured rather than assumed.
 *
 * @param {Bitmap} bitmap
 * @param {number} [patch] side of each corner patch, clamped to the image
 * @returns {number[]} the mean [r, g, b] of the four patches
 */
export function sampleCornerColor(bitmap, patch = CORNER_PATCH) {
  const { width, height, data } = bitmap
  const size = Math.max(1, Math.min(patch, Math.floor(width / 2), Math.floor(height / 2)))
  const origins = [
    [0, 0],
    [width - size, 0],
    [0, height - size],
    [width - size, height - size]
  ]
  let red = 0
  let green = 0
  let blue = 0
  let count = 0
  for (const [originX, originY] of origins) {
    for (let y = originY; y < originY + size; y++) {
      for (let x = originX; x < originX + size; x++) {
        const index = (y * width + x) * 4
        red += data[index]
        green += data[index + 1]
        blue += data[index + 2]
        count++
      }
    }
  }
  return [red / count, green / count, blue / count]
}

/**
 * Alpha for one pixel given how far its color sits from the key. Everything
 * inside `tolerance` disappears (that band absorbs JPEG noise on the flat
 * backdrop), everything past `tolerance + feather` is kept as painted, and the
 * ramp between the two softens the cut so edges keep no hard halo.
 *
 * @param {number} distance
 * @param {number} tolerance
 * @param {number} feather
 * @returns {number} 0-255
 */
export function keyAlpha(distance, tolerance, feather) {
  if (distance <= tolerance) return 0
  if (feather <= 0) return 255
  if (distance >= tolerance + feather) return 255
  return Math.round(((distance - tolerance) / feather) * 255)
}

/**
 * How hard to despill a pixel: full strength on the backdrop itself, fading to
 * nothing at `radius`. Paint far from the key color (skin, wood, ore glow) is
 * never touched.
 *
 * @param {number} distance
 * @param {number} tolerance
 * @param {number} radius
 * @param {number} maxStrength
 * @returns {number} 0-maxStrength
 */
export function spillStrength(distance, tolerance, radius, maxStrength) {
  if (distance <= tolerance) return maxStrength
  if (distance >= radius) return 0
  return maxStrength * (1 - (distance - tolerance) / (radius - tolerance))
}

/**
 * Pull magenta spill out of a pixel by dropping red and blue toward green.
 * "How magenta" a color is equals `(r + b) / 2 - g`, so anything green-dominant
 * or merely warm (skin, gold, wood) is left almost exactly as painted.
 *
 * @param {readonly number[]} pixel
 * @param {number} strength 0-1
 * @returns {number[]} the corrected [r, g, b]
 */
export function despillMagenta(pixel, strength) {
  const [red, green, blue] = pixel
  const magenta = (red + blue) / 2 - green
  if (magenta <= 0 || strength <= 0) return [red, green, blue]
  const cut = magenta * strength
  return [Math.max(0, Math.round(red - cut)), green, Math.max(0, Math.round(blue - cut))]
}

/**
 * The tightest box around everything the key left visible.
 *
 * @param {Bitmap} bitmap
 * @param {number} [alphaThreshold] alpha at or below this counts as background
 * @returns {Box | null} null when the image is entirely background
 */
export function contentBox(bitmap, alphaThreshold = CONTENT_ALPHA) {
  const { width, height, data } = bitmap
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= alphaThreshold) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * The smallest box covering all of them, nulls skipped. Cropping every dwarf
 * pose to this one box is what keeps the animation frames from jittering: same
 * canvas, same baseline, whatever each pose happens to occupy.
 *
 * @param {readonly (Box | null)[]} boxes
 * @returns {Box | null}
 */
export function unionBox(boxes) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const box of boxes) {
    if (box === null || box === undefined) continue
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  if (maxX === -Infinity) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Grow a box by `margin` on every side, clamped to the image.
 *
 * @param {Box | null} box
 * @param {number} margin
 * @param {number} width image width
 * @param {number} height image height
 * @returns {Box | null}
 */
export function padBox(box, margin, width, height) {
  if (box === null || box === undefined) return null
  const x = Math.max(0, box.x - margin)
  const y = Math.max(0, box.y - margin)
  return {
    x,
    y,
    width: Math.min(width, box.x + box.width + margin) - x,
    height: Math.min(height, box.y + box.height + margin) - y
  }
}
