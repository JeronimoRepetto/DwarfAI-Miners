// layer: L6
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type EvtFrame,
  type IpcError,
  type SnapshotPage,
  type SnapshotParams
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient, HostEvent } from '../../window/ports/hostClient'
import { createHostReadRows, forwardHostEvents, HOST_EVENT, HOST_SNAPSHOT } from './hostRead'

// L6 (17 §1.6): A-N01 `getHostSnapshot` and A-N02 `onHostEvent` (14 §2.2, §1.2, §1.7, §1.8; ADR-003 items 6, 7) over a
// faked HostClient, each payload checked against the registry's schema (14 §1.4). The macrotask boundary is the test's:
// `defer` queues the flush and the test runs it, so no real timer runs (17 §5.3).

const EPOCH = 'epoch-0082'
const DWARF = '01920000-0000-7000-9000-00000000000a'

function page(snapshotId: string, index: number, next?: string): SnapshotPage {
  return {
    snapshotId,
    seq: 41,
    epoch: EPOCH,
    chunks: index === 0 ? [{ section: 'mines', data: [] }] : [{ section: 'dwarfs', data: [] }],
    ...(next === undefined ? {} : { next })
  }
}

function frame(seq: number): EvtFrame {
  return {
    type: 'evt',
    seq,
    epoch: EPOCH,
    name: 'dwarf.departed',
    data: { dwarfId: DWARF, mineId: DWARF, cause: 'closed-elsewhere' }
  } as EvtFrame
}

/** The HostClient members the rows read: pages by cursor, and the subscribe handler the test drives. */
class FakeHostRead implements Pick<HostClient, 'snapshot' | 'subscribe'> {
  readonly requests: SnapshotParams[] = []
  readonly pages = new Map<string, SnapshotPage>()
  refusal: IpcError | null = null
  handler: ((event: HostEvent) => void) | null = null

  snapshot(params: SnapshotParams): Promise<SnapshotPage> {
    this.requests.push(params)
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    const found = this.pages.get(params.cursor ?? 'first')
    return found === undefined ? Promise.reject(new Error('no page')) : Promise.resolve(found)
  }

  subscribe(handler: (event: HostEvent) => void): () => void {
    this.handler = handler
    return () => (this.handler = null)
  }

  emit(event: HostEvent): void {
    this.handler?.(event)
  }
}

/** A mode window as the relay sends to it. */
class RecordingWindow {
  readonly batches: unknown[] = []
  send(channel: string, payload: unknown): void {
    expect(channel).toBe(HOST_EVENT)
    // 14 §1.4: the push payload is the registry's `HostFrame[]`.
    this.batches.push(CHANNELS[HOST_EVENT].response.parse(payload))
  }
}

describe('A-N01 getHostSnapshot and A-N02 onHostEvent (14 §2.2, §1.2, §1.8)', () => {
  it('[ADR-003] onHostEvent forwards frames in seq order as batches and getHostSnapshot relays every page unchanged', async () => {
    const client = new FakeHostRead()
    const first = page('snap-1', 0, 'snap-1/1')
    const last = page('snap-1', 1)
    client.pages.set('first', first)
    client.pages.set('snap-1/1', last)
    const rows = createHostReadRows(client)

    // A-N01: each page is the Host's, unchanged, in the registry's IpcResult<SnapshotPage>.
    const answers = [
      await rows.serve(HOST_SNAPSHOT, { sections: ['mines', 'dwarfs'] }),
      await rows.serve(HOST_SNAPSHOT, { snapshotId: 'snap-1', cursor: 'snap-1/1' })
    ]
    expect(client.requests).toEqual([
      { sections: ['mines', 'dwarfs'] },
      { snapshotId: 'snap-1', cursor: 'snap-1/1' }
    ])
    for (const answer of answers) CHANNELS[HOST_SNAPSHOT].response.parse(answer)
    expect(answers).toEqual([
      { ok: true, value: first },
      { ok: true, value: last }
    ])
    expect((answers[0] as { value: unknown }).value).toBe(first)
    // A call error of the Host is its error branch (14 §1.5), never a throw into the renderer.
    client.refusal = { code: 'SNAPSHOT_EXPIRED', message: 'expired', retryable: true }
    expect(await rows.serve(HOST_SNAPSHOT, { snapshotId: 'snap-1', cursor: 'snap-1/1' })).toEqual({
      ok: false,
      error: client.refusal
    })
    expect(await rows.serve('host:connection:get', undefined)).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })

    // A-N02: every frame of one macrotask reaches every mode window as one batch, in seq order.
    const panel = new RecordingWindow()
    const veta = new RecordingWindow()
    const macrotasks: Array<() => void> = []
    const stop = forwardHostEvents({
      client,
      windows: () => [panel, veta],
      defer: (run) => macrotasks.push(run)
    })
    client.emit({ kind: 'frame', frame: frame(42) })
    client.emit({ kind: 'frame', frame: frame(43) })
    // A snapshot event is HostClient's own rehydration: renderers read the snapshot through A-N01.
    client.emit({ kind: 'snapshot', snapshot: { ...first, chunks: [] } })
    client.emit({ kind: 'frame', frame: frame(44) })
    expect(panel.batches).toEqual([])
    expect(macrotasks).toHaveLength(1)

    macrotasks.shift()?.()
    expect(panel.batches).toEqual([[frame(42), frame(43), frame(44)]])
    expect(veta.batches).toEqual(panel.batches)

    client.emit({ kind: 'frame', frame: frame(45) })
    client.emit({ kind: 'frame', frame: frame(46) })
    expect(macrotasks).toHaveLength(1)
    macrotasks.shift()?.()
    expect(panel.batches).toEqual([
      [frame(42), frame(43), frame(44)],
      [frame(45), frame(46)]
    ])
    expect(veta.batches).toEqual(panel.batches)

    // A macrotask with no frame sends no batch; after the stop nothing is forwarded.
    stop()
    client.emit({ kind: 'frame', frame: frame(47) })
    expect(macrotasks).toHaveLength(0)
    expect(panel.batches).toHaveLength(2)
  })
})
