// The seam-B frame codec (ADR-003 item 4, frozen): `uint32` little-endian length + UTF-8 JSON. Pure,
// over `Uint8Array` (no Node `Buffer`), so the Host's transport and the UI's HostClient (later:
// ISSUE-051) share it.
//
// - The length counts the UTF-8 bytes of the JSON, not the 4-byte prefix.
// - Caps: 1 MiB per frame before `hello.ok`, 8 MiB after (`helloOk()` raises it). A frame over the
//   cap is refused from its prefix alone, so its body is never awaited or buffered; the caller then
//   closes the connection without sending a frame (14 §1.5).
// - A body that is not UTF-8 JSON is `malformed`, never a throw (16 §2.1: a malformed client frame
//   is a typed refusal, never a crash).
// - A refusal is final: nothing decodes after it.

/** The cap on a frame's JSON length before `hello.ok`: 1 MiB (ADR-003 item 4). */
export const FRAME_CAP_BEFORE_HELLO_OK = 1024 * 1024
/** The cap on a frame's JSON length after `hello.ok`: 8 MiB (ADR-003 item 4). */
export const FRAME_CAP_AFTER_HELLO_OK = 8 * 1024 * 1024

const PREFIX_BYTES = 4

/** One frame: the length prefix and the UTF-8 JSON of `message`. */
export function encodeFrame(message: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message))
  const frame = new Uint8Array(PREFIX_BYTES + json.length)
  new DataView(frame.buffer).setUint32(0, json.length, true)
  frame.set(json, PREFIX_BYTES)
  return frame
}

export type DecodedFrame =
  | { kind: 'frame'; message: unknown }
  /** `bytes` is the length the prefix announced. */
  | { kind: 'oversize'; bytes: number }
  | { kind: 'malformed' }

/** An incremental decoder: push chunks as they arrive, then drain `next()` until it returns null. */
export class FrameDecoder {
  private readonly chunks: Uint8Array[] = []
  private buffered = 0
  private cap = FRAME_CAP_BEFORE_HELLO_OK
  private failed = false
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true })

  push(chunk: Uint8Array): void {
    if (this.failed || chunk.length === 0) return
    this.chunks.push(chunk)
    this.buffered += chunk.length
  }

  /** The next complete frame, a refusal, or null when more bytes are needed. */
  next(): DecodedFrame | null {
    if (this.failed || this.buffered < PREFIX_BYTES) return null
    const prefix = this.peek(PREFIX_BYTES)
    const length = new DataView(prefix.buffer, prefix.byteOffset, PREFIX_BYTES).getUint32(0, true)
    if (length > this.cap) return this.fail({ kind: 'oversize', bytes: length })
    if (this.buffered < PREFIX_BYTES + length) return null
    this.take(PREFIX_BYTES)
    const body = this.take(length)
    try {
      return { kind: 'frame', message: JSON.parse(this.utf8.decode(body)) as unknown }
    } catch {
      return this.fail({ kind: 'malformed' })
    }
  }

  /** Raises the cap to 8 MiB for every frame after `hello.ok`. */
  helloOk(): void {
    this.cap = FRAME_CAP_AFTER_HELLO_OK
  }

  private fail(refusal: DecodedFrame): DecodedFrame {
    this.failed = true
    this.chunks.length = 0
    this.buffered = 0
    return refusal
  }

  /** The first `count` buffered bytes, left in place. */
  private peek(count: number): Uint8Array {
    const first = this.chunks[0]
    if (first !== undefined && first.length >= count) return first.subarray(0, count)
    return this.copy(count, false)
  }

  /** The first `count` buffered bytes, removed. */
  private take(count: number): Uint8Array {
    return this.copy(count, true)
  }

  private copy(count: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(count)
    let written = 0
    let index = 0
    while (written < count) {
      const chunk = this.chunks[index]
      if (chunk === undefined) break
      const part = chunk.subarray(0, Math.min(chunk.length, count - written))
      out.set(part, written)
      written += part.length
      if (!consume) {
        index += 1
      } else if (part.length === chunk.length) {
        this.chunks.shift()
      } else {
        this.chunks[0] = chunk.subarray(part.length)
      }
    }
    if (consume) this.buffered -= count
    return out
  }
}
