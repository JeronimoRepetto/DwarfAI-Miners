/**
 * A from-scratch PNG codec limited to exactly what this pipeline needs:
 * decoding the three design-source annotation images (8-bit, non-interlaced,
 * RGB or RGBA, no palette) and encoding the validation overlays this pipeline
 * renders back out. Node's own `zlib` does the DEFLATE work; everything
 * PNG-shaped — chunk framing, CRC32, and the per-scanline filter/unfilter
 * math — is implemented here so the pipeline adds no new dependency (see
 * scripts/extract-map-coordinates.mjs for why: PNG header/chunk reading with
 * built-ins only).
 *
 * Scope is deliberately narrow and fails loudly outside it: interlaced,
 * palette, or <8-bit source PNGs throw rather than silently producing wrong
 * pixels. All three source images this pipeline reads are 8-bit RGB,
 * non-interlaced (verified against their own IHDR), so that scope is not a
 * gap for this pipeline's own inputs.
 *
 * @typedef {{ width: number, height: number, rgba: Uint8Array }} Bitmap
 *   Decoded/encodable pixel data, always RGBA regardless of the source
 *   PNG's color type, row-major, four bytes per pixel.
 */

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Color types this codec understands: truecolor and truecolor+alpha. */
const COLOR_TYPE_RGB = 2
const COLOR_TYPE_RGBA = 6

const CRC_TABLE = buildCrcTable()

/** Standard PNG/zlib CRC32 table, built once at module load. */
function buildCrcTable() {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
}

/**
 * CRC32 over a buffer, the exact checksum every PNG chunk trailer carries.
 *
 * @param {Buffer | Uint8Array} bytes
 * @returns {number} unsigned 32-bit CRC
 */
export function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * The Paeth predictor PNG filter type 4 uses: whichever of the left, above,
 * or upper-left neighbor is numerically closest to `a + b - c`.
 *
 * @param {number} a left
 * @param {number} b above
 * @param {number} c upper-left
 * @returns {number}
 */
export function paethPredictor(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Reverse one of PNG's five per-scanline filters, given the already-unfiltered
 * previous row. Operates byte-by-byte over the raw (non-RGBA-packed) row, as
 * the PNG spec defines filtering — `bytesPerPixel` is the stride back to the
 * "left" neighbor, which differs between RGB (3) and RGBA (4) source images.
 *
 * @param {number} filterType 0-4
 * @param {Uint8Array} row filtered bytes for this scanline, mutated in place into the unfiltered result
 * @param {Uint8Array} previousRow already-unfiltered previous scanline (all zero for row 0)
 * @param {number} bytesPerPixel
 */
export function unfilterRow(filterType, row, previousRow, bytesPerPixel) {
  for (let x = 0; x < row.length; x++) {
    const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0
    const above = previousRow[x]
    const upperLeft = x >= bytesPerPixel ? previousRow[x - bytesPerPixel] : 0
    let value = row[x]
    switch (filterType) {
      case 0:
        break
      case 1:
        value = (value + left) & 0xff
        break
      case 2:
        value = (value + above) & 0xff
        break
      case 3:
        value = (value + Math.floor((left + above) / 2)) & 0xff
        break
      case 4:
        value = (value + paethPredictor(left, above, upperLeft)) & 0xff
        break
      default:
        throw new Error(`unsupported PNG filter type ${filterType}`)
    }
    row[x] = value
  }
}

/**
 * Walk a PNG's chunk stream and hand each `{ type, data }` chunk to `onChunk`.
 * Stops at IEND. Throws if the file does not open with the PNG signature.
 *
 * @param {Buffer} buffer
 * @param {(type: string, data: Buffer) => void} onChunk
 */
function walkChunks(buffer, onChunk) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG file (bad signature)')
  }
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const data = buffer.subarray(dataStart, dataStart + length)
    onChunk(type, data)
    offset = dataStart + length + 4 // + 4 skips the CRC trailer
    if (type === 'IEND') break
  }
}

/**
 * Decode an 8-bit, non-interlaced RGB/RGBA PNG into a flat RGBA bitmap.
 *
 * @param {Buffer} buffer raw PNG file bytes
 * @returns {Bitmap}
 */
export function decodePng(buffer) {
  /** @type {{ width: number, height: number, bitDepth: number, colorType: number, interlace: number } | null} */
  let ihdr = null
  const idatParts = []
  walkChunks(buffer, (type, data) => {
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
        interlace: data.readUInt8(12)
      }
    } else if (type === 'IDAT') {
      idatParts.push(data)
    }
  })
  if (ihdr === null) throw new Error('PNG has no IHDR chunk')
  const { width, height, bitDepth, colorType, interlace } = ihdr
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported by this codec')
  if (bitDepth !== 8) throw new Error(`only 8-bit PNGs are supported, got bit depth ${bitDepth}`)
  if (colorType !== COLOR_TYPE_RGB && colorType !== COLOR_TYPE_RGBA) {
    throw new Error(`only RGB/RGBA PNGs are supported, got color type ${colorType}`)
  }
  const channels = colorType === COLOR_TYPE_RGBA ? 4 : 3
  const inflated = inflateSync(Buffer.concat(idatParts))
  const stride = width * channels

  const rgba = new Uint8Array(width * height * 4)
  let previousRow = new Uint8Array(stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filterType = inflated[pos]
    pos += 1
    const row = Uint8Array.from(inflated.subarray(pos, pos + stride))
    pos += stride
    unfilterRow(filterType, row, previousRow, channels)
    for (let x = 0; x < width; x++) {
      const src = x * channels
      const dst = (y * width + x) * 4
      rgba[dst] = row[src]
      rgba[dst + 1] = row[src + 1]
      rgba[dst + 2] = row[src + 2]
      rgba[dst + 3] = channels === 4 ? row[src + 3] : 255
    }
    previousRow = row
  }
  return { width, height, rgba }
}

/** Build one length-prefixed, CRC-trailed PNG chunk. */
function buildChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

/**
 * Encode an RGBA bitmap as an unfiltered (filter type 0) 8-bit RGB PNG.
 * Used only to render validation overlays for this pipeline's own scratch
 * output — never for the committed source art — so a simple, always-correct
 * encoding is preferred over matching the compression PNG tooling produces.
 *
 * @param {Bitmap} bitmap
 * @returns {Buffer}
 */
export function encodePng({ width, height, rgba }) {
  const channels = 3
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter type "None"
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4
      const dst = rowStart + 1 + x * channels
      raw[dst] = rgba[src]
      raw[dst + 1] = rgba[src + 1]
      raw[dst + 2] = rgba[src + 2]
    }
  }
  const compressed = deflateSync(raw)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(COLOR_TYPE_RGB, 9)
  ihdr.writeUInt8(0, 10) // compression method
  ihdr.writeUInt8(0, 11) // filter method
  ihdr.writeUInt8(0, 12) // interlace method
  return Buffer.concat([
    SIGNATURE,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', compressed),
    buildChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Read just the IHDR fields without inflating pixel data — used by the
 * report to name each source image's pixel dimensions.
 *
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number }}
 */
export function readDimensions(buffer) {
  let result = null
  walkChunks(buffer, (type, data) => {
    if (type === 'IHDR' && result === null) {
      result = { width: data.readUInt32BE(0), height: data.readUInt32BE(4) }
    }
  })
  if (result === null) throw new Error('PNG has no IHDR chunk')
  return result
}
