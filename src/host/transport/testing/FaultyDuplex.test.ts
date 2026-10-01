// The CH-03 fault wrapper's own faults (17 §1.10), so later transport tests can rely on each one.
import { describe, expect, it } from 'vitest'
import { FaultyDuplex } from './FaultyDuplex'

/** Every chunk the Host end reads, and whether it closed. */
function hostReads(faults: FaultyDuplex) {
  const seen = { chunks: [] as number[][], closed: false }
  faults.host.on('data', (chunk: Uint8Array) => seen.chunks.push([...chunk]))
  faults.host.on('error', () => {})
  faults.host.once('close', () => (seen.closed = true))
  return seen
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

describe('FaultyDuplex (CH-03)', () => {
  it('[CH-03] passes bytes both ways unchanged when no fault is on', async () => {
    const faults = new FaultyDuplex()
    const seen = hostReads(faults)
    const back: number[][] = []
    faults.client.on('data', (chunk: Uint8Array) => back.push([...chunk]))
    faults.client.write(Uint8Array.from([1, 2, 3]))
    faults.host.write(Uint8Array.from([9]))
    await settle()
    expect(seen.chunks).toEqual([[1, 2, 3]])
    expect(back).toEqual([[9]])
  })

  it('[CH-03] stall holds the client bytes until resume, and split delivers them in chunks', async () => {
    const faults = new FaultyDuplex()
    const seen = hostReads(faults)
    faults.stall()
    faults.client.write(Uint8Array.from([1, 2, 3, 4, 5]))
    await settle()
    expect(seen.chunks).toEqual([])
    faults.splitInto(2)
    faults.resume()
    await settle()
    expect(seen.chunks).toEqual([[1, 2], [3, 4], [5]])
  })

  it('[CH-03] drop after N bytes delivers exactly N bytes, then kills the connection', async () => {
    const faults = new FaultyDuplex()
    const seen = hostReads(faults)
    let clientClosed = false
    faults.client.on('error', () => {})
    faults.client.once('close', () => (clientClosed = true))
    faults.dropAfter(4)
    faults.client.write(Uint8Array.from([1, 2, 3]))
    faults.client.write(Uint8Array.from([4, 5, 6]))
    await settle()
    expect(seen.chunks.flat()).toEqual([1, 2, 3, 4])
    expect(seen.closed).toBe(true)
    expect(clientClosed).toBe(true)
  })

  it('[CH-03] stallReads leaves the Host bytes unsent, as a client that stopped reading, and resumeReads delivers them and drains', async () => {
    const faults = new FaultyDuplex()
    const back: number[][] = []
    faults.client.on('data', (chunk: Uint8Array) => back.push([...chunk]))
    let drained = 0
    faults.host.on('drain', () => (drained += 1))
    faults.stallReads()
    const chunk = new Uint8Array(32 * 1024).fill(7)
    faults.host.write(chunk)
    faults.host.write(chunk)
    await settle()
    expect(back).toEqual([])
    // The bytes sit unsent on the Host end, as in a full socket buffer.
    expect(faults.host.writableLength).toBe(64 * 1024)
    expect(faults.host.writableNeedDrain).toBe(true)

    faults.resumeReads()
    await settle()
    expect(back.flat()).toHaveLength(64 * 1024)
    expect(faults.host.writableLength).toBe(0)
    expect(drained).toBe(1)
  })

  it('[CH-03] close kills both ends, as a closed pipe or socket handle', async () => {
    const faults = new FaultyDuplex()
    const seen = hostReads(faults)
    faults.close()
    await settle()
    expect(seen.closed).toBe(true)
    expect(faults.client.destroyed).toBe(true)
  })
})
