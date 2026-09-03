/**
 * Marker detection: given a flat RGBA bitmap (see png.mjs) and the exact fill
 * color a design tool used for one annotation class (a red circle, a blue
 * triangle, ...), find every connected blob of near-that-color pixels and
 * reduce each to one centroid. One blob is assumed to be one marker — true
 * for every class this pipeline extracts, since annotations in the source
 * PNGs never touch or overlap (verified per-class by the blob-count vs.
 * expected-count check in extract-map-coordinates.mjs, and visually by the
 * rendered overlay).
 *
 * @typedef {{ width: number, height: number, rgba: Uint8Array }} Bitmap
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ centroid: Point, size: number, bbox: { minX: number, minY: number, maxX: number, maxY: number } }} Blob
 */

/**
 * Euclidean RGB distance, alpha ignored — same crude-but-sufficient metric
 * scripts/art/keying.mjs uses, appropriate here for the same reason: these
 * are flat design-tool fills, not photographic color.
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
 * A boolean mask of every pixel within `tolerance` of `targetColor`.
 *
 * @param {Bitmap} bitmap
 * @param {readonly number[]} targetColor [r, g, b]
 * @param {number} tolerance max RGB distance to count as a match
 * @returns {Uint8Array} width*height, 1 where matched
 */
export function colorMask(bitmap, targetColor, tolerance) {
  const { width, height, rgba } = bitmap
  const mask = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    if (colorDistance([rgba[i], rgba[i + 1], rgba[i + 2]], targetColor) <= tolerance) {
      mask[p] = 1
    }
  }
  return mask
}

/**
 * Label 8-connected components of a boolean mask and reduce each to a
 * centroid, pixel count, and bounding box. Iterative flood fill (an explicit
 * stack, not recursion) so it holds up on a component with thousands of
 * pixels without blowing the call stack.
 *
 * @param {Uint8Array} mask width*height, 1 = candidate pixel
 * @param {number} width
 * @param {number} height
 * @param {number} [minSize] components smaller than this are dropped as noise
 * @returns {Blob[]} in the order components were discovered (row-major scan)
 */
export function connectedComponents(mask, width, height, minSize = 1) {
  const visited = new Uint8Array(width * height)
  /** @type {Blob[]} */
  const blobs = []
  const stack = []

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || visited[start] === 1) continue

    visited[start] = 1
    stack.push(start)
    let sumX = 0
    let sumY = 0
    let size = 0
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1

    while (stack.length > 0) {
      const p = stack.pop()
      const x = p % width
      const y = Math.floor(p / width)
      sumX += x
      sumY += y
      size++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const np = ny * width + nx
          if (mask[np] === 1 && visited[np] === 0) {
            visited[np] = 1
            stack.push(np)
          }
        }
      }
    }

    if (size >= minSize) {
      blobs.push({
        centroid: { x: sumX / size, y: sumY / size },
        size,
        bbox: { minX, minY, maxX, maxY }
      })
    }
  }

  return blobs
}

/**
 * Convenience: mask + label in one call, the shape most callers want.
 *
 * @param {Bitmap} bitmap
 * @param {readonly number[]} targetColor
 * @param {number} tolerance
 * @param {number} [minSize]
 * @returns {Blob[]}
 */
export function findMarkers(bitmap, targetColor, tolerance, minSize = 1) {
  const mask = colorMask(bitmap, targetColor, tolerance)
  return connectedComponents(mask, bitmap.width, bitmap.height, minSize)
}
