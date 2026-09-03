import { describe, expect, it } from 'vitest'
import { colorDistance, colorMask, connectedComponents, findMarkers } from './cluster.mjs'

/** A width*height RGBA bitmap, every pixel `background` except the given overrides. */
function bitmap(width, height, background, overrides) {
  const rgba = new Uint8Array(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = background[0]
    rgba[p * 4 + 1] = background[1]
    rgba[p * 4 + 2] = background[2]
    rgba[p * 4 + 3] = 255
  }
  for (const [x, y, color] of overrides) {
    const i = (y * width + x) * 4
    rgba[i] = color[0]
    rgba[i + 1] = color[1]
    rgba[i + 2] = color[2]
  }
  return { width, height, rgba }
}

describe('colorDistance', () => {
  it('is zero for identical colors', () => {
    expect(colorDistance([1, 2, 3], [1, 2, 3])).toBe(0)
  })

  it('is the Euclidean RGB distance', () => {
    expect(colorDistance([0, 0, 0], [3, 4, 0])).toBe(5)
  })
})

describe('colorMask', () => {
  it('flags only pixels within tolerance of the target color', () => {
    const image = bitmap(3, 1, [0, 0, 0], [[1, 0, [255, 0, 0]]])
    const mask = colorMask(image, [255, 0, 0], 10)
    expect([...mask]).toEqual([0, 1, 0])
  })
})

describe('connectedComponents', () => {
  it('finds nothing in an empty mask', () => {
    expect(connectedComponents(new Uint8Array(9), 3, 3)).toEqual([])
  })

  it('separates two blobs that do not touch', () => {
    // 5x1: X . . . X
    const mask = Uint8Array.from([1, 0, 0, 0, 1])
    const blobs = connectedComponents(mask, 5, 1)
    expect(blobs).toHaveLength(2)
    expect(blobs[0].centroid).toEqual({ x: 0, y: 0 })
    expect(blobs[1].centroid).toEqual({ x: 4, y: 0 })
  })

  it('merges pixels touching only diagonally (8-connectivity)', () => {
    // 2x2, top-left and bottom-right set — corner-adjacent, one blob
    const mask = Uint8Array.from([1, 0, 0, 1])
    const blobs = connectedComponents(mask, 2, 2)
    expect(blobs).toHaveLength(1)
    expect(blobs[0].size).toBe(2)
    expect(blobs[0].centroid).toEqual({ x: 0.5, y: 0.5 })
  })

  it('computes the centroid as the mean position of every pixel in the blob', () => {
    // 3x1 all set: centroid x = (0+1+2)/3 = 1
    const blobs = connectedComponents(Uint8Array.from([1, 1, 1]), 3, 1)
    expect(blobs[0].centroid).toEqual({ x: 1, y: 0 })
    expect(blobs[0].bbox).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 0 })
  })

  it('drops components smaller than minSize', () => {
    const mask = Uint8Array.from([1, 0, 1, 1, 1]) // sizes 1 and 3
    expect(connectedComponents(mask, 5, 1, 2)).toHaveLength(1)
    expect(connectedComponents(mask, 5, 1, 1)).toHaveLength(2)
  })
})

describe('findMarkers', () => {
  it('masks and labels in one call', () => {
    const image = bitmap(
      4,
      1,
      [0, 0, 0],
      [
        [0, 0, [255, 49, 49]],
        [1, 0, [255, 49, 49]],
        [3, 0, [255, 49, 49]]
      ]
    )
    const blobs = findMarkers(image, [255, 49, 49], 5, 1)
    expect(blobs).toHaveLength(2) // {0,1} touching, {3} alone
    expect(blobs.map((b) => b.size)).toEqual([2, 1])
  })
})
