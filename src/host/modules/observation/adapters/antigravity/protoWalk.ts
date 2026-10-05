// A bounded protobuf wire walker (15 §5 Antigravity row, AMENDMENT-13): just enough of the wire
// format to read `gen_metadata.data` of Antigravity's conversations database, whose blobs are
// plaintext protobuf with no published schema. Pure: no I/O, no clock.
//
// - It yields varint (wire type 0) and length-delimited (wire type 2) fields only. Fixed-width
//   fields (wire types 1 and 5) are framed and stepped over; groups (3, 4), the undefined wire
//   types (6, 7) and field number 0 are not this format.
// - Limits: a blob over `PROTO_MAX_BYTES`, a path deeper than `PROTO_MAX_DEPTH`, more than
//   `PROTO_MAX_FIELDS` fields at one level, a varint over ten bytes or a length past the end make
//   the blob `undecodable`. It never throws (INV-38): the reader counts `undecodable` as drift
//   (FM-068) and goes on.
// - `fieldsAt` follows a field-number path through nested messages and returns every occurrence
//   of the last field, in wire order (a repeated or split message is merged by the caller, last
//   value wins, as protobuf merges).
//
// Design reference: `observer@a402217:internal/adapter/antigravity/clidb.go` `decodeGenMetadata`
// (:419-447), Apache-2.0 (20 §2.4): the idea of a schema-less walk along fixed field paths is
// taken from it; no code is copied.

/** What the walker answers for a blob it cannot frame. */
export const UNDECODABLE = 'undecodable' as const

/** The largest blob the walker reads (a generation's metadata is a few KiB). */
export const PROTO_MAX_BYTES = 1024 * 1024

/** The deepest field path the walker follows. */
export const PROTO_MAX_DEPTH = 8

/** The most fields the walker reads at one level of one message. */
export const PROTO_MAX_FIELDS = 4096

export type ProtoField =
  | { field: number; kind: 'varint'; value: bigint }
  | { field: number; kind: 'bytes'; bytes: Uint8Array }

type Walk = ProtoField[] | typeof UNDECODABLE

/** A varint at `at`, or null when it runs past the end or over ten bytes. */
function readVarint(blob: Uint8Array, at: number): { value: bigint; next: number } | null {
  let value = 0n
  for (let i = 0; i < 10; i++) {
    const position = at + i
    if (position >= blob.length) return null
    const byte = blob[position]!
    value |= BigInt(byte & 0x7f) << BigInt(7 * i)
    if ((byte & 0x80) === 0) return { value, next: position + 1 }
  }
  return null
}

/** The varint and length-delimited fields of one message level, in wire order. */
export function walkFields(blob: Uint8Array): Walk {
  if (blob.length > PROTO_MAX_BYTES) return UNDECODABLE
  const fields: ProtoField[] = []
  let at = 0
  let count = 0
  while (at < blob.length) {
    if (++count > PROTO_MAX_FIELDS) return UNDECODABLE
    const key = readVarint(blob, at)
    if (key === null) return UNDECODABLE
    const field = Number(key.value >> 3n)
    const wire = Number(key.value & 7n)
    if (field === 0 || key.value >> 3n > 0x1fffffffn) return UNDECODABLE
    at = key.next
    switch (wire) {
      case 0: {
        const value = readVarint(blob, at)
        if (value === null) return UNDECODABLE
        fields.push({ field, kind: 'varint', value: value.value })
        at = value.next
        break
      }
      case 1:
      case 5: {
        const width = wire === 1 ? 8 : 4
        if (at + width > blob.length) return UNDECODABLE
        at += width
        break
      }
      case 2: {
        const length = readVarint(blob, at)
        if (length === null || length.value > BigInt(blob.length - length.next)) {
          return UNDECODABLE
        }
        const end = length.next + Number(length.value)
        fields.push({ field, kind: 'bytes', bytes: blob.subarray(length.next, end) })
        at = end
        break
      }
      default:
        return UNDECODABLE
    }
  }
  return fields
}

/**
 * Every occurrence of the field at `path` (field numbers from the outermost message in), in wire
 * order; [] when the path is absent; `undecodable` when a message on the way cannot be framed.
 */
export function fieldsAt(blob: Uint8Array, path: readonly number[]): Walk {
  if (path.length === 0 || path.length > PROTO_MAX_DEPTH) return UNDECODABLE
  let level: Uint8Array[] = [blob]
  for (let depth = 0; depth < path.length; depth++) {
    const wanted = path[depth]!
    const found: ProtoField[] = []
    for (const message of level) {
      const fields = walkFields(message)
      if (fields === UNDECODABLE) return UNDECODABLE
      for (const field of fields) if (field.field === wanted) found.push(field)
    }
    if (depth === path.length - 1) return found
    level = found.flatMap((field) => (field.kind === 'bytes' ? [field.bytes] : []))
  }
  return []
}
