// layer: L1
// L1 (17 §1.1) of the bounded protobuf wire walker the Antigravity conversations-database reader
// decodes `gen_metadata.data` with (15 §5 Antigravity row, AMENDMENT-13): varint and
// length-delimited fields only, depth and length limits, and never a throw (INV-38): a blob it
// cannot frame is `undecodable`, which the reader counts as drift (FM-068).
import { describe, expect, it } from 'vitest'
import {
  fieldsAt,
  PROTO_MAX_BYTES,
  PROTO_MAX_DEPTH,
  PROTO_MAX_FIELDS,
  UNDECODABLE,
  walkFields
} from './protoWalk'

/** A protobuf varint. */
function varint(value: number | bigint): number[] {
  let v = BigInt(value)
  const out: number[] = []
  do {
    let byte = Number(v & 0x7fn)
    v >>= 7n
    if (v !== 0n) byte |= 0x80
    out.push(byte)
  } while (v !== 0n)
  return out
}

function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire)
}

function uint(field: number, value: number | bigint): number[] {
  return [...tag(field, 0), ...varint(value)]
}

function bytes(field: number, body: number[]): number[] {
  return [...tag(field, 2), ...varint(body.length), ...body]
}

function text(field: number, value: string): number[] {
  return bytes(field, [...new TextEncoder().encode(value)])
}

const blob = (parts: number[]) => Uint8Array.from(parts)

/** A deterministic byte stream (xorshift32), so the fuzz case is the same on every run. */
function noise(seed: number, length: number): Uint8Array {
  let x = seed >>> 0 || 1
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    out[i] = x & 0xff
  }
  return out
}

describe('protoWalk', () => {
  it('[C-21] reads varints and nested length-delimited fields along a path, every occurrence in order', () => {
    const usage = [...uint(1, 1200), ...uint(5, 3400), ...uint(10, 2n ** 40n)]
    const message = blob(
      bytes(1, [
        ...text(19, 'synthetic-model'),
        ...bytes(17, bytes(2, usage)),
        ...bytes(17, bytes(2, uint(1, 7)))
      ])
    )
    const top = walkFields(message)
    expect(top).not.toBe(UNDECODABLE)
    expect(top).toHaveLength(1)

    const model = fieldsAt(message, [1, 19])
    expect(model).toEqual([
      { field: 19, kind: 'bytes', bytes: new TextEncoder().encode('synthetic-model') }
    ])
    expect(fieldsAt(message, [1, 17, 2, 1])).toEqual([
      { field: 1, kind: 'varint', value: 1200n },
      { field: 1, kind: 'varint', value: 7n }
    ])
    expect(fieldsAt(message, [1, 17, 2, 10])).toEqual([
      { field: 10, kind: 'varint', value: 2n ** 40n }
    ])
    // An absent field is an empty answer, not an undecodable blob.
    expect(fieldsAt(message, [1, 17, 2, 9])).toEqual([])
    expect(fieldsAt(message, [3])).toEqual([])
    // Fixed-width fields are framed and stepped over, never yielded.
    const fixed = blob([
      ...tag(4, 1),
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      ...tag(5, 5),
      1,
      2,
      3,
      4,
      ...uint(6, 9)
    ])
    expect(walkFields(fixed)).toEqual([{ field: 6, kind: 'varint', value: 9n }])
  })

  it('[INV-38] a truncated or oversized protobuf blob returns undecodable and never throws', () => {
    const good = bytes(1, [...text(19, 'synthetic-model'), ...bytes(17, bytes(2, uint(1, 1200)))])

    // Truncated anywhere: inside a tag, a length, a varint or a nested body.
    for (let cut = 1; cut < good.length; cut++) {
      const truncated = blob(good.slice(0, cut))
      expect(fieldsAt(truncated, [1, 17, 2, 1]), `cut at ${cut}`).toBe(UNDECODABLE)
    }
    // A length that runs past the end, at the top and nested along the path.
    expect(walkFields(blob([...tag(1, 2), ...varint(50), 1, 2, 3]))).toBe(UNDECODABLE)
    expect(fieldsAt(blob(bytes(1, [...tag(17, 2), ...varint(9), 1])), [1, 17, 2])).toBe(UNDECODABLE)
    // A varint longer than ten bytes, or a fixed-width field cut short.
    expect(walkFields(blob([...tag(1, 0), ...Array<number>(11).fill(0x80), 0]))).toBe(UNDECODABLE)
    expect(walkFields(blob([...tag(4, 1), 1, 2, 3]))).toBe(UNDECODABLE)
    // Groups (wire types 3, 4) and the undefined wire types 6, 7 are not this format.
    for (const wire of [3, 4, 6, 7]) {
      expect(walkFields(blob([...tag(1, wire), 0])), `wire ${wire}`).toBe(UNDECODABLE)
    }
    // Field number 0 is invalid in every protobuf.
    expect(walkFields(blob([0x00, 0x01]))).toBe(UNDECODABLE)

    // Oversized: a blob over the byte limit, a path deeper than the depth limit, more fields than
    // the field limit at one level.
    expect(walkFields(new Uint8Array(PROTO_MAX_BYTES + 1))).toBe(UNDECODABLE)
    expect(fieldsAt(blob(good), Array<number>(PROTO_MAX_DEPTH + 1).fill(1))).toBe(UNDECODABLE)
    const many = blob(Array.from({ length: PROTO_MAX_FIELDS + 1 }, () => uint(2, 1)).flat())
    expect(walkFields(many)).toBe(UNDECODABLE)

    // Whatever the bytes, the walker answers and never throws.
    for (let seed = 1; seed <= 200; seed++) {
      const random = noise(seed, 1 + (seed % 97))
      expect(() => fieldsAt(random, [1, 17, 2, 1])).not.toThrow()
      expect(() => fieldsAt(random, [1, 19])).not.toThrow()
    }
  })
})
