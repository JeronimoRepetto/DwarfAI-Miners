// The bounded outbound queue of one connection (14 §1.8; ADR-003 item 8, frozen): every frame the
// Host writes to an authenticated connection — `evt` frames and responses — goes through it, in
// order, so a response never overtakes a frame enqueued before it (14 §1.7 "effects before
// response"). The Host never blocks its event loop on a client: nothing here waits.
//
// - While the socket takes bytes, a frame is written at once. Once the socket asks to drain, the
//   frames wait in this queue, in order, and are written as it drains.
// - Coalescing (14 §1.8, closed list): within one Host tick a waiting `dwarf.changed` (per
//   dwarf), `activity.changed` (per disclosure), `ledger.changed` (per mine) or `ask.step` (per ask)
//   is folded into the newer frame of the same name and key, which keeps its own, highest `seq`
//   and its place in the order. No other frame is coalesced, and a response never is.
// - High water: once the connection's unsent bytes (the socket's plus this queue's) exceed
//   HOST_OUTBOUND_HIGH_WATER (4 MiB), the queue stops taking `evt` frames for it and drops the
//   waiting ones; responses are still written. As soon as the socket drained, `onDrained` runs
//   once: the frame publisher sends the one `resync-required {reason:'backpressure'}` and frames
//   flow again (framePublisher.ts).
import type { Duplex } from 'node:stream'
import { encodeFrame } from '@dwarfai/contracts'

/** 14 §1.8: HOST_OUTBOUND_HIGH_WATER = 4 MiB (architect value). */
export const HOST_OUTBOUND_HIGH_WATER = 4 * 1024 * 1024

/** The `evt` frame as the outbound queue writes it (14 §3.2 `EvtFrame`). */
export interface OutboundEvt {
  type: 'evt'
  seq: number
  epoch: string
  name: string
  data: unknown
}

/**
 * 14 §1.8: the frames that may be coalesced, each with the key it is folded by. Nothing else is
 * ever coalesced.
 */
export const COALESCING_KEYS: Readonly<Record<string, (data: unknown) => unknown>> = Object.freeze({
  'dwarf.changed': (data: unknown) => field(field(data, 'dwarf'), 'id'), // latest per dwarfId
  'activity.changed': (data: unknown) => field(data, 'disclosureId'), // latest per disclosureId
  'ledger.changed': (data: unknown) => field(data, 'mineId'), // latest per mineId
  'ask.step': (data: unknown) => field(data, 'askId') // latest per askId
})

export interface OutboundOptions {
  /** Runs once each time the socket drained after the high water was passed. */
  onDrained: () => void
  /** Defaults to HOST_OUTBOUND_HIGH_WATER. */
  highWater?: number
}

interface Waiting {
  bytes: Uint8Array
  /** Set for an `evt` frame (dropped past the high water); `key` only for a coalescing one. */
  evt?: { name: string; key: unknown; tick: number }
}

export class Outbound {
  private queue: Waiting[] = []
  private queuedBytes = 0
  private overflowed = false
  private closed = false
  private readonly highWater: number

  constructor(
    private readonly stream: Duplex,
    private readonly options: OutboundOptions
  ) {
    this.highWater = options.highWater ?? HOST_OUTBOUND_HIGH_WATER
    stream.on('drain', this.pump)
  }

  /** Writes or queues one `evt` frame; dropped while the connection is past the high water. */
  sendEvt(evt: OutboundEvt): void {
    if (this.closed || this.overflowed) return
    const key = COALESCING_KEYS[evt.name]?.(evt.data)
    const tick = currentHostTick()
    if (key !== undefined) this.foldWaiting(evt.name, key, tick)
    this.push({ bytes: encodeFrame(evt), evt: { name: evt.name, key, tick } })
    if (this.unsentBytes() > this.highWater) this.overflow()
  }

  /** Writes or queues a frame that is not an `evt` (a response): never dropped, never folded. */
  write(frame: unknown): void {
    if (this.closed) return
    this.push({ bytes: encodeFrame(frame) })
  }

  /** Hands every waiting frame to the socket, whatever it asks (before the connection ends). */
  flush(): void {
    if (!this.stream.destroyed) for (const waiting of this.queue) this.stream.write(waiting.bytes)
    this.queue = []
    this.queuedBytes = 0
  }

  /** Drops whatever waits and stops listening: the connection closed. */
  close(): void {
    this.closed = true
    this.queue = []
    this.queuedBytes = 0
    this.stream.off('drain', this.pump)
  }

  /** The bytes handed to this connection and not yet taken by its peer. */
  private unsentBytes(): number {
    return this.stream.writableLength + this.queuedBytes
  }

  private push(waiting: Waiting): void {
    if (this.stream.destroyed) return
    if (this.queue.length === 0 && !this.stream.writableNeedDrain) {
      this.stream.write(waiting.bytes)
      return
    }
    this.queue.push(waiting)
    this.queuedBytes += waiting.bytes.length
  }

  /** Removes a waiting frame of the same name and key queued in this tick: the newer one replaces it. */
  private foldWaiting(name: string, key: unknown, tick: number): void {
    const index = this.queue.findIndex(
      (waiting) =>
        waiting.evt !== undefined &&
        waiting.evt.name === name &&
        waiting.evt.key === key &&
        waiting.evt.tick === tick
    )
    if (index === -1) return
    const [folded] = this.queue.splice(index, 1)
    if (folded !== undefined) this.queuedBytes -= folded.bytes.length
  }

  /** Past the high water: no more `evt` frames, and the waiting ones are dropped. */
  private overflow(): void {
    this.overflowed = true
    this.queue = this.queue.filter((waiting) => waiting.evt === undefined)
    this.queuedBytes = this.queue.reduce((sum, waiting) => sum + waiting.bytes.length, 0)
    // A socket that does not ask to drain will not say it drained: recover on the next turn.
    if (!this.stream.writableNeedDrain) queueMicrotask(this.pump)
  }

  /** Writes waiting frames while the socket takes them; once all are taken, ends an overflow. */
  private readonly pump = (): void => {
    while (!this.closed && this.queue.length > 0 && !this.stream.writableNeedDrain) {
      const waiting = this.queue.shift()
      if (waiting === undefined) break
      this.queuedBytes -= waiting.bytes.length
      this.stream.write(waiting.bytes)
    }
    if (this.closed || this.queue.length > 0 || this.stream.writableNeedDrain) return
    if (this.overflowed) {
      this.overflowed = false
      this.options.onDrained()
    }
  }
}

/**
 * The Host tick a frame was queued in (14 §1.8 "within one Host tick"): a counter that moves on at
 * the end of each event-loop turn in which it was read.
 */
let hostTick = 0
let tickArmed = false
function currentHostTick(): number {
  if (!tickArmed) {
    tickArmed = true
    setImmediate(() => {
      hostTick += 1
      tickArmed = false
    })
  }
  return hostTick
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined
}
