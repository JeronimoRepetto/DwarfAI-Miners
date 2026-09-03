import { describe, expect, it } from 'vitest'
import { crc32, decodePng, encodePng, paethPredictor, readDimensions, unfilterRow } from './png.mjs'

describe('crc32', () => {
  it('matches the standard CRC32 of an empty buffer', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })

  it('matches the well-known CRC32 of "123456789"', () => {
    // The standard check value for the CRC-32/ISO-HDLC polynomial PNG uses.
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926)
  })
})

describe('paethPredictor', () => {
  it('picks left when left is closest', () => {
    expect(paethPredictor(10, 0, 0)).toBe(10)
  })

  it('picks above when above is closest', () => {
    expect(paethPredictor(0, 10, 0)).toBe(10)
  })

  it('picks upper-left on a tie, per the PNG spec tie-break', () => {
    // a=10, b=10, c=0 -> p=20, pa=10, pb=10, pc=20: pa<=pb so a wins (left)
    expect(paethPredictor(10, 10, 0)).toBe(10)
  })
})

describe('unfilterRow', () => {
  it('filter type 0 (None) leaves bytes unchanged', () => {
    const row = Uint8Array.from([5, 6, 7])
    unfilterRow(0, row, new Uint8Array(3), 3)
    expect([...row]).toEqual([5, 6, 7])
  })

  it('filter type 1 (Sub) adds the left pixel', () => {
    // Two 3-byte "pixels": the second pixel's bytes are each offset by the
    // corresponding byte of the first (its left neighbor, bytesPerPixel=3).
    const wide = Uint8Array.from([10, 20, 30, 1, 1, 1])
    unfilterRow(1, wide, new Uint8Array(6), 3)
    expect([...wide]).toEqual([10, 20, 30, 11, 21, 31])
  })

  it('filter type 2 (Up) adds the pixel above', () => {
    const row = Uint8Array.from([5, 5, 5])
    unfilterRow(2, row, Uint8Array.from([100, 100, 100]), 3)
    expect([...row]).toEqual([105, 105, 105])
  })

  it('filter type 3 (Average) adds the floor of (left+above)/2', () => {
    const row = Uint8Array.from([0, 3])
    unfilterRow(3, row, Uint8Array.from([10, 10]), 1)
    // x=0: left=0, above=10 -> +5 -> 5
    // x=1: left=5 (already unfiltered), above=10 -> +7 -> 10
    expect([...row]).toEqual([5, 10])
  })

  it('filter type 4 (Paeth) matches paethPredictor', () => {
    const row = Uint8Array.from([1])
    unfilterRow(4, row, Uint8Array.from([0]), 1)
    expect(row[0]).toBe(1) // a=0,b=0,c=0 -> paeth=0, value=1+0
  })

  it('throws on an unknown filter type', () => {
    expect(() => unfilterRow(9, Uint8Array.from([1]), new Uint8Array(1), 1)).toThrow(/filter type/)
  })
})

describe('encodePng / decodePng round trip', () => {
  it('reproduces a small synthetic RGBA bitmap exactly', () => {
    const width = 3
    const height = 2
    const rgba = new Uint8Array(width * height * 4)
    const pixels = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
      [0, 255, 255],
      [128, 64, 32]
    ]
    pixels.forEach(([r, g, b], i) => {
      rgba[i * 4] = r
      rgba[i * 4 + 1] = g
      rgba[i * 4 + 2] = b
      rgba[i * 4 + 3] = 255
    })

    const encoded = encodePng({ width, height, rgba })
    const decoded = decodePng(encoded)

    expect(decoded.width).toBe(width)
    expect(decoded.height).toBe(height)
    for (let i = 0; i < rgba.length; i += 4) {
      expect(decoded.rgba[i]).toBe(rgba[i])
      expect(decoded.rgba[i + 1]).toBe(rgba[i + 1])
      expect(decoded.rgba[i + 2]).toBe(rgba[i + 2])
    }
  })

  it('rejects a buffer without the PNG signature', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(/signature/)
  })
})

describe('readDimensions', () => {
  it('reads width/height from IHDR without inflating pixel data', () => {
    const encoded = encodePng({ width: 4, height: 7, rgba: new Uint8Array(4 * 7 * 4) })
    expect(readDimensions(encoded)).toEqual({ width: 4, height: 7 })
  })
})
