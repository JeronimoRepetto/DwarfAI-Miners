/**
 * Pure math behind the app-icon badge (see scripts/build-icons.mjs).
 *
 * The badge is a circular, radially-shaded backdrop the painted mound art
 * sits on so the icon keeps a legible silhouette down to 16x16 — same split
 * as scripts/art/keying.mjs: measure the math in isolation here, keep actual
 * pixel buffers and file I/O out of it.
 */

/**
 * Linear interpolation between `a` and `b` at `t` (0-1, unclamped).
 *
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * Hermite smoothstep: 0 at or below `edge0`, 1 at or above `edge1`, an S-curve
 * between. Used to soften the badge's circular edge over a few pixels instead
 * of a hard cutoff that would alias once downscaled to 16x16.
 *
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number} 0-1
 */
export function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Alpha for one badge pixel, given its distance from the badge center. Fully
 * opaque well inside `radius`, fully transparent past it, feathered by
 * `feather` pixels either side of the boundary.
 *
 * @param {number} distance
 * @param {number} radius
 * @param {number} feather
 * @returns {number} 0-255
 */
export function badgeAlpha(distance, radius, feather) {
  const fade = smoothstep(radius - feather, radius + feather, distance)
  return Math.round((1 - fade) * 255)
}

/**
 * Badge fill color at one pixel: a radial gradient from `centerColor` to
 * `edgeColor`, so the badge reads as a lit disc rather than a flat cutout.
 * `distance` beyond `radius` clamps to the edge color.
 *
 * @param {number} distance
 * @param {number} radius
 * @param {readonly number[]} centerColor [r, g, b]
 * @param {readonly number[]} edgeColor [r, g, b]
 * @returns {number[]} [r, g, b], each rounded 0-255
 */
export function badgeColor(distance, radius, centerColor, edgeColor) {
  const t = radius <= 0 ? 1 : Math.min(1, Math.max(0, distance / radius))
  return [
    Math.round(lerp(centerColor[0], edgeColor[0], t)),
    Math.round(lerp(centerColor[1], edgeColor[1], t)),
    Math.round(lerp(centerColor[2], edgeColor[2], t))
  ]
}

/**
 * Where to place a `contentSize`-wide/tall box so it sits centered inside a
 * `canvasSize` square canvas.
 *
 * @param {number} canvasSize
 * @param {number} contentSize
 * @returns {number}
 */
export function centerOffset(canvasSize, contentSize) {
  return Math.round((canvasSize - contentSize) / 2)
}

/**
 * Resize dimensions that fit `sourceWidth`x`sourceHeight` to exactly
 * `targetWidth` wide, preserving aspect ratio (mirrors build-art.mjs's
 * resizeTo, minus the Jimp instance it mutates in place).
 *
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} targetWidth
 * @returns {{ width: number, height: number }}
 */
export function scaleToWidth(sourceWidth, sourceHeight, targetWidth) {
  const width = Math.max(1, Math.round(targetWidth))
  const height = Math.max(1, Math.round(sourceHeight * (targetWidth / sourceWidth)))
  return { width, height }
}
