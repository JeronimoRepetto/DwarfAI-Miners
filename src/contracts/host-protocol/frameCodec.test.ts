// layer: L6
// L6 (17 §1.6): the seam-B frame codec of ADR-003 item 4, fed split and coalesced chunks (ADR-003
// Verification "Unit: frame codec (split/coalesced chunks)").
import { describe, expect, it } from 'vitest'
import {
  encodeFrame,
  FRAME_CAP_AFTER_HELLO_OK,
  FRAME_CAP_BEFORE_HELLO_OK,
  FrameDecoder,
  type DecodedFrame
} from './frameCodec'

const MESSAGES: readonly unknown[] = [
  { type: 'req', id: '1', method: 'ping', params: {} },
  // Multi-byte UTF-8, so a chunk boundary can fall inside one character.
  { type: 'req', id: '2', method: 'x', params: { text: 'pico ⛏ y montaña' } },
  { type: 'res', id: '3', ok: true, result: [1, 2, 3] }
]

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Feeds `bytes` in chunks of the given sizes (the last size repeats) and drains every result. */
function decodeInChunks(bytes: Uint8Array, sizes: readonly number[]): DecodedFrame[] {
  const decoder = new FrameDecoder()
  const results: DecodedFrame[] = []
  let offset = 0
  let index = 0
  while (offset < bytes.length) {
    const size = sizes[Math.min(index, sizes.length - 1)] ?? 1
    decoder.push(bytes.subarray(offset, offset + size))
    offset += size
    index += 1
    for (let result = decoder.next(); result !== null; result = decoder.next()) results.push(result)
  }
  return results
}

/** A frame header announcing `length` bytes of JSON. */
function header(length: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, length, true)
  return bytes
}

/** A JSON string literal whose UTF-8 encoding is exactly `length` bytes. */
function jsonOfLength(length: number): Uint8Array {
  return new TextEncoder().encode(`"${'a'.repeat(length - 2)}"`)
}

describe('the seam-B frame codec (ADR-003 item 4)', () => {
  it('[ADR-003] frames split across chunks and several frames in one chunk decode to the same messages', () => {
    const encoded = MESSAGES.map((message) => encodeFrame(message))
    // The length prefix is uint32 little-endian and counts the UTF-8 bytes of the JSON.
    const json = new TextEncoder().encode(JSON.stringify(MESSAGES[1]))
    expect(encoded[1]?.subarray(0, 4)).toEqual(header(json.length))
    expect(encoded[1]?.subarray(4)).toEqual(json)

    const stream = concat(encoded)
    const expected = MESSAGES.map((message) => ({ kind: 'frame', message }))
    // All coalesced in one chunk, one byte at a time, and boundaries inside headers and bodies.
    for (const sizes of [[stream.length], [1], [3], [2, 7, 5, 11], [6, 1, 40]]) {
      expect(decodeInChunks(stream, sizes), `chunk sizes ${sizes.join(',')}`).toEqual(expected)
    }
  })

  it('[ADR-003, FM-030] a frame over 1 MiB before hello.ok or over 8 MiB after is refused and closes the connection without a frame', () => {
    expect(FRAME_CAP_BEFORE_HELLO_OK).toBe(1_048_576)
    expect(FRAME_CAP_AFTER_HELLO_OK).toBe(8_388_608)

    // Exactly at the cap is a frame.
    const atCap = new FrameDecoder()
    atCap.push(concat([header(FRAME_CAP_BEFORE_HELLO_OK), jsonOfLength(FRAME_CAP_BEFORE_HELLO_OK)]))
    expect(atCap.next()).toMatchObject({ kind: 'frame' })

    // One byte over is refused from the header alone: the body is never awaited or buffered.
    const before = new FrameDecoder()
    before.push(header(FRAME_CAP_BEFORE_HELLO_OK + 1))
    expect(before.next()).toEqual({ kind: 'oversize', bytes: FRAME_CAP_BEFORE_HELLO_OK + 1 })
    // The refusal is final: nothing decodes after it.
    before.push(encodeFrame({ type: 'req' }))
    expect(before.next()).toBeNull()

    // After hello.ok the cap is 8 MiB: a 2 MiB frame decodes, 8 MiB + 1 is refused.
    const after = new FrameDecoder()
    after.helloOk()
    after.push(concat([header(2 * 1_048_576), jsonOfLength(2 * 1_048_576)]))
    expect(after.next()).toMatchObject({ kind: 'frame' })
    after.push(header(FRAME_CAP_AFTER_HELLO_OK + 1))
    expect(after.next()).toEqual({ kind: 'oversize', bytes: FRAME_CAP_AFTER_HELLO_OK + 1 })
  })

  it('[ADR-003] a frame whose body is not UTF-8 JSON decodes as malformed, never a throw', () => {
    for (const body of [
      new TextEncoder().encode('{"type":'),
      new Uint8Array([0x22, 0xff, 0xfe, 0x22]) // a JSON string of bytes that are not UTF-8
    ]) {
      const decoder = new FrameDecoder()
      decoder.push(concat([header(body.length), body]))
      expect(decoder.next()).toEqual({ kind: 'malformed' })
      expect(decoder.next()).toBeNull()
    }
  })
})
