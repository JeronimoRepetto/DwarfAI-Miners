import { describe, expect, it } from 'vitest'
import {
  colorDistance,
  contentBox,
  despillMagenta,
  keyAlpha,
  padBox,
  sampleCornerColor,
  spillStrength,
  unionBox
} from './keying.mjs'

/**
 * Build a tiny RGBA bitmap the same shape Jimp exposes as `image.bitmap`.
 * `pixels` is a row-major array of [r, g, b] or [r, g, b, a] tuples.
 */
function bitmap(width, height, pixels) {
  const data = new Uint8Array(width * height * 4)
  pixels.forEach(([r, g, b, a = 255], index) => {
    data[index * 4] = r
    data[index * 4 + 1] = g
    data[index * 4 + 2] = b
    data[index * 4 + 3] = a
  })
  return { width, height, data }
}

/** A bitmap where every pixel is the same color. */
function flat(width, height, pixel) {
  return bitmap(
    width,
    height,
    Array.from({ length: width * height }, () => pixel)
  )
}

const MAGENTA = [252, 2, 250]

describe('colorDistance', () => {
  it('is zero for identical colors', () => {
    expect(colorDistance(MAGENTA, [...MAGENTA])).toBe(0)
  })

  it('is the Euclidean RGB distance', () => {
    expect(colorDistance([0, 0, 0], [3, 4, 0])).toBe(5)
    expect(colorDistance([0, 0, 0], [255, 255, 255])).toBeCloseTo(441.673, 3)
  })

  it('ignores the alpha channel', () => {
    expect(colorDistance([10, 20, 30, 0], [10, 20, 30, 255])).toBe(0)
  })
})

describe('sampleCornerColor', () => {
  it('averages the four corner pixels', () => {
    // 2x2: every pixel is a corner, so the sample is the mean of all four.
    const image = bitmap(2, 2, [
      [200, 0, 200],
      [204, 0, 200],
      [200, 4, 200],
      [204, 4, 200]
    ])
    expect(sampleCornerColor(image, 1)).toEqual([202, 2, 200])
  })

  it('ignores the subject painted in the middle of a flat backdrop', () => {
    const pixels = Array.from({ length: 16 }, () => MAGENTA)
    pixels[5] = [255, 240, 120] // a bright lamp in the centre
    pixels[6] = [255, 240, 120]
    pixels[9] = [30, 20, 10]
    pixels[10] = [30, 20, 10]
    expect(sampleCornerColor(bitmap(4, 4, pixels), 1)).toEqual(MAGENTA)
  })

  it('clamps a patch larger than the image instead of reading out of bounds', () => {
    expect(sampleCornerColor(flat(3, 3, [100, 20, 90]), 64)).toEqual([100, 20, 90])
  })
})

describe('keyAlpha', () => {
  it('makes anything within the tolerance fully transparent', () => {
    expect(keyAlpha(0, 50, 40)).toBe(0)
    expect(keyAlpha(50, 50, 40)).toBe(0)
  })

  it('makes anything past the feather fully opaque', () => {
    expect(keyAlpha(90, 50, 40)).toBe(255)
    expect(keyAlpha(400, 50, 40)).toBe(255)
  })

  it('feathers the edge linearly so keyed art keeps no hard halo', () => {
    expect(keyAlpha(70, 50, 40)).toBe(128)
    expect(keyAlpha(60, 50, 40)).toBe(64)
  })

  it('falls back to a hard cut when there is no feather', () => {
    expect(keyAlpha(50, 50, 0)).toBe(0)
    expect(keyAlpha(51, 50, 0)).toBe(255)
  })
})

describe('spillStrength', () => {
  it('is strongest right at the key color', () => {
    expect(spillStrength(0, 50, 150, 0.7)).toBeCloseTo(0.7)
    expect(spillStrength(50, 50, 150, 0.7)).toBeCloseTo(0.7)
  })

  it('fades to nothing at the spill radius', () => {
    expect(spillStrength(150, 50, 150, 0.7)).toBe(0)
    expect(spillStrength(300, 50, 150, 0.7)).toBe(0)
  })

  it('ramps down linearly between the tolerance and the radius', () => {
    expect(spillStrength(100, 50, 150, 0.7)).toBeCloseTo(0.35)
  })

  it('degrades to a plain cut-off when the radius is inside the tolerance', () => {
    expect(spillStrength(10, 50, 40, 0.7)).toBeCloseTo(0.7)
    expect(spillStrength(60, 50, 40, 0.7)).toBe(0)
  })
})

describe('despillMagenta', () => {
  it('leaves a neutral grey untouched', () => {
    expect(despillMagenta([120, 120, 120], 1)).toEqual([120, 120, 120])
  })

  it('leaves green-dominant paint untouched', () => {
    expect(despillMagenta([40, 200, 60], 1)).toEqual([40, 200, 60])
  })

  it('pulls a magenta-tinted pixel back toward neutral', () => {
    // magenta amount = (200 + 200) / 2 - 100 = 100, half of it removed
    expect(despillMagenta([200, 100, 200], 0.5)).toEqual([150, 100, 150])
  })

  it('barely touches warm skin, which is only faintly magenta', () => {
    // magenta amount = (226 + 127) / 2 - 171 = 5.5
    expect(despillMagenta([226, 171, 127], 1)).toEqual([221, 171, 122])
  })

  it('does nothing at zero strength', () => {
    expect(despillMagenta([252, 2, 250], 0)).toEqual([252, 2, 250])
  })

  it('never pushes a channel below zero', () => {
    const [r, , b] = despillMagenta([10, 0, 10], 1)
    expect(r).toBe(0)
    expect(b).toBe(0)
  })
})

describe('contentBox', () => {
  it('returns null when every pixel was keyed away', () => {
    expect(contentBox(flat(4, 4, [0, 0, 0, 0]))).toBeNull()
  })

  it('boxes a single opaque pixel', () => {
    const pixels = Array.from({ length: 16 }, () => [0, 0, 0, 0])
    pixels[6] = [10, 20, 30, 255] // x = 2, y = 1
    expect(contentBox(bitmap(4, 4, pixels))).toEqual({ x: 2, y: 1, width: 1, height: 1 })
  })

  it('spans every opaque pixel', () => {
    const pixels = Array.from({ length: 16 }, () => [0, 0, 0, 0])
    pixels[5] = [10, 20, 30, 255] // x = 1, y = 1
    pixels[14] = [10, 20, 30, 255] // x = 2, y = 3
    expect(contentBox(bitmap(4, 4, pixels))).toEqual({ x: 1, y: 1, width: 2, height: 3 })
  })

  it('treats faint feathered alpha as background', () => {
    const pixels = Array.from({ length: 16 }, () => [0, 0, 0, 0])
    pixels[0] = [10, 20, 30, 5]
    pixels[10] = [10, 20, 30, 255] // x = 2, y = 2
    expect(contentBox(bitmap(4, 4, pixels), 24)).toEqual({ x: 2, y: 2, width: 1, height: 1 })
  })
})

describe('unionBox', () => {
  it('returns null for no boxes at all', () => {
    expect(unionBox([])).toBeNull()
    expect(unionBox([null, null])).toBeNull()
  })

  it('covers every box so all poses share one canvas', () => {
    expect(
      unionBox([
        { x: 10, y: 20, width: 30, height: 40 },
        { x: 5, y: 25, width: 10, height: 10 },
        null,
        { x: 12, y: 18, width: 50, height: 12 }
      ])
    ).toEqual({ x: 5, y: 18, width: 57, height: 42 })
  })

  it('returns the single box unchanged', () => {
    const box = { x: 1, y: 2, width: 3, height: 4 }
    expect(unionBox([box])).toEqual(box)
  })
})

describe('padBox', () => {
  it('grows the box by the margin on every side', () => {
    expect(padBox({ x: 10, y: 10, width: 20, height: 20 }, 5, 100, 100)).toEqual({
      x: 5,
      y: 5,
      width: 30,
      height: 30
    })
  })

  it('clamps to the image bounds', () => {
    expect(padBox({ x: 1, y: 1, width: 98, height: 98 }, 10, 100, 100)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100
    })
  })

  it('returns null for a null box', () => {
    expect(padBox(null, 5, 100, 100)).toBeNull()
  })
})
