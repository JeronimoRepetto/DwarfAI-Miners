// The bounded replay ring of one connection target (ADR-003 item 8, frozen; 14 §1.8): the frames the
// Host published to that target, newest last, so that a client which reconnects to the same epoch
// with a `lastSeq` still covered gets exactly the frames it missed. It keeps at most 512 events or
// 4 MiB, whichever limit is reached first, and evicts the oldest frame first.
//
// Keyed by `(epoch, seq)`: a ring lives in one Host process, so every frame it holds carries the
// process epoch, and the subscribe checks the epoch half of a `resume` before it reads the ring
// (framePublisher.ts). `seq` is the target's: monotonic, with gaps where the target issued a frame
// it does not hold (a `resync-required` for one connection only, framePublisher.ts).
//
// The DB, not the ring, is the durable source for a cold reopen (ADR-003 item 8): the ring is
// memory only and ends with the Host process. It never holds open asks as events (item 7).

export interface RingEntry {
  seq: number
  name: string
  data: unknown
  /** The frame's size as the ring counts it toward its 4 MiB (framePublisher.ts). */
  bytes: number
}

/** ADR-003 item 8: 512 events. */
export const RING_MAX_EVENTS = 512
/** ADR-003 item 8: 4 MiB. */
export const RING_MAX_BYTES = 4 * 1024 * 1024

export interface RingLimits {
  maxEvents: number
  maxBytes: number
}

export class ReplayRing {
  private readonly held: RingEntry[] = []
  private heldBytes = 0
  /** The highest seq evicted so far: every frame after it is still held. */
  private evictedThrough = 0

  constructor(
    private readonly limits: RingLimits = { maxEvents: RING_MAX_EVENTS, maxBytes: RING_MAX_BYTES }
  ) {}

  /** Holds `entry` (its seq above every held one) and evicts the oldest until both limits hold. */
  push(entry: RingEntry): void {
    this.held.push(entry)
    this.heldBytes += entry.bytes
    while (this.held.length > this.limits.maxEvents || this.heldBytes > this.limits.maxBytes) {
      const evicted = this.held.shift()
      if (evicted === undefined) break
      this.heldBytes -= evicted.bytes
      this.evictedThrough = evicted.seq
    }
  }

  /** The frames held now, oldest first. */
  entries(): readonly RingEntry[] {
    return this.held
  }

  /** The bytes held now (19 §10 "replay ring fill"). */
  bytes(): number {
    return this.heldBytes
  }

  /**
   * The frames after `lastSeq`, oldest first, when every one of them is still held; `null` when one
   * was evicted, or when `lastSeq` is above `latestSeq` (the last seq the target issued).
   */
  after(lastSeq: number, latestSeq: number): RingEntry[] | null {
    if (lastSeq < this.evictedThrough || lastSeq > latestSeq) return null
    return this.held.filter((held) => held.seq > lastSeq)
  }
}
