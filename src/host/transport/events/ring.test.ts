// layer: L1
// L1 (17 §1.1): the bounded replay ring of one connection target (ADR-003 item 8, frozen; 14 §1.8):
// 512 events or 4 MiB, whichever limit is reached first, the oldest frame evicted first.
import { describe, expect, it } from 'vitest'
import { RING_MAX_BYTES, RING_MAX_EVENTS, ReplayRing, type RingEntry } from './ring'

const MIB = 1024 * 1024

const entry = (seq: number, bytes = 10): RingEntry => ({
  seq,
  name: 'dwarf.arrived',
  data: { n: seq },
  bytes
})

describe('ReplayRing (ADR-003 item 8)', () => {
  it('[ADR-003] the ring keeps at most 512 events or 4 MiB and evicts the oldest first', () => {
    expect(RING_MAX_EVENTS).toBe(512)
    expect(RING_MAX_BYTES).toBe(4 * MIB)

    // The event limit: 600 small frames keep the newest 512.
    const byCount = new ReplayRing()
    for (let seq = 1; seq <= 600; seq += 1) byCount.push(entry(seq))
    expect(byCount.entries()).toHaveLength(512)
    expect(byCount.entries()[0]?.seq).toBe(89)
    expect(byCount.entries().at(-1)?.seq).toBe(600)

    // The byte limit: 1 MiB frames, so the fifth evicts the first and the ring holds 4 MiB.
    const byBytes = new ReplayRing()
    for (let seq = 1; seq <= 5; seq += 1) byBytes.push(entry(seq, MIB))
    expect(byBytes.entries().map((held) => held.seq)).toEqual([2, 3, 4, 5])
    expect(byBytes.bytes()).toBe(4 * MIB)

    // A frame that would pass 4 MiB by one byte evicts the oldest first.
    byBytes.push(entry(6, 1))
    expect(byBytes.entries().map((held) => held.seq)).toEqual([3, 4, 5, 6])
    expect(byBytes.bytes()).toBe(3 * MIB + 1)
  })

  it('[ADR-003] a lastSeq still in the ring yields exactly the missed frames in order', () => {
    const ring = new ReplayRing({ maxEvents: 4, maxBytes: 4 * MIB })
    for (let seq = 1; seq <= 6; seq += 1) ring.push(entry(seq))
    // Held: 3, 4, 5, 6 (1 and 2 evicted).

    expect(ring.after(4, 6)?.map((held) => held.seq)).toEqual([5, 6])
    // The frame just before the oldest held one is still a resumable lastSeq: nothing after it is lost.
    expect(ring.after(2, 6)?.map((held) => held.seq)).toEqual([3, 4, 5, 6])
    // Nothing missed: the client saw the latest frame.
    expect(ring.after(6, 6)).toEqual([])
    // A frame after lastSeq was evicted: not resumable.
    expect(ring.after(1, 6)).toBeNull()
    // A seq this target never issued: not resumable.
    expect(ring.after(7, 6)).toBeNull()

    // A seq the target issued without holding it (a frame for one connection only) is skipped, not lost.
    const gapped = new ReplayRing()
    gapped.push(entry(1))
    gapped.push(entry(3))
    expect(gapped.after(1, 4)?.map((held) => held.seq)).toEqual([3])
    expect(gapped.after(2, 4)?.map((held) => held.seq)).toEqual([3])
    expect(gapped.after(0, 4)?.map((held) => held.seq)).toEqual([1, 3])
  })
})
