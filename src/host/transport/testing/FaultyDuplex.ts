// The CH-03 fault wrapper (17 §1.10): an in-process duplex pair, like inProcessDuplex, whose
// client → Host direction runs through faults a test switches on, so the transport's behaviour on
// a dropped or silent local channel is driven exactly. Test-only (R14).
//
// - `close()`: the connection is killed, as a closed pipe or socket handle (both ends close).
// - `stall()` / `resume()`: the client's bytes are held, not delivered, until `resume()`, as a
//   suspended peer whose writes never reach the Host.
// - `splitInto(size)`: every later delivery reaches the Host in chunks of at most `size` bytes,
//   each its own read, so a frame arrives split.
// - `dropAfter(bytes)`: once `bytes` more bytes reached the Host, the connection is killed and the
//   rest of the write is dropped.
//
// Host → client bytes pass through unchanged, in the chunks they were written in.
import { Duplex } from 'node:stream'
import type { DuplexPair } from './inProcessDuplex'

export class FaultyDuplex implements DuplexPair {
  /** The end the Host's transport takes. */
  readonly host: Duplex
  /** The end the test client drives. */
  readonly client: Duplex
  private stalled = false
  private held: Uint8Array[] = []
  private chunkSize = Number.POSITIVE_INFINITY
  private dropBudget = Number.POSITIVE_INFINITY

  constructor() {
    this.host = this.makeEnd(
      (chunk) => this.pushTo(this.client, chunk),
      () => this.client
    )
    this.client = this.makeEnd(
      (chunk) => this.towardHost(chunk),
      () => this.host
    )
  }

  close(): void {
    this.client.destroy()
  }

  stall(): void {
    this.stalled = true
  }

  resume(): void {
    this.stalled = false
    const held = this.held
    this.held = []
    for (const chunk of held) this.deliver(chunk)
  }

  splitInto(size: number): void {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(`FaultyDuplex.splitInto needs a positive integer; got ${size}`)
    }
    this.chunkSize = size
  }

  dropAfter(bytes: number): void {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new RangeError(`FaultyDuplex.dropAfter needs a non-negative integer; got ${bytes}`)
    }
    this.dropBudget = bytes
  }

  private towardHost(chunk: Uint8Array): void {
    if (this.stalled) this.held.push(chunk)
    else this.deliver(chunk)
  }

  private deliver(chunk: Uint8Array): void {
    let rest = chunk
    while (rest.length > 0 && !this.host.destroyed) {
      if (this.dropBudget === 0) {
        this.close()
        return
      }
      const size = Math.min(rest.length, this.chunkSize, this.dropBudget)
      this.pushTo(this.host, rest.subarray(0, size))
      this.dropBudget -= size
      rest = rest.subarray(size)
    }
    if (this.dropBudget === 0) this.close()
  }

  private pushTo(end: Duplex, chunk: Uint8Array): void {
    if (!end.destroyed) end.push(Uint8Array.from(chunk))
  }

  private makeEnd(onWrite: (chunk: Uint8Array) => void, peer: () => Duplex): Duplex {
    return new Duplex({
      allowHalfOpen: false,
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        onWrite(Uint8Array.from(chunk))
        callback()
      },
      final(callback) {
        const other = peer()
        if (!other.destroyed) other.push(null)
        callback()
      },
      destroy(error, callback) {
        const other = peer()
        if (!other.destroyed) other.destroy()
        callback(error)
      }
    })
  }
}
