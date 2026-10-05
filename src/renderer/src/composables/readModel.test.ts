import { describe, expect, it } from 'vitest'
import type {
  HostFrame,
  IpcResult,
  SnapshotChunk,
  SnapshotPage,
  SnapshotParams
} from '@dwarfai/contracts'
import { createReadModel, followHost, type HostReadPath } from './readModel'

/*
 * The shared `ReadModel<S>` helper (ADR-033 item 3; 14 §4.3 rules 1–3), on its own: a counter model whose state is
 * the list of applied frame seqs, over a scripted read path. `useMines.test.ts` covers it through the board.
 */
describe('readModel', () => {
  const EPOCH = 'epoch-1'

  function counter() {
    const state = { applied: [] as number[], snapshots: 0 }
    const model = createReadModel<typeof state, HostFrame>({
      state,
      replace(data) {
        state.applied = [...data.applied]
        state.snapshots += 1
      },
      apply(frame) {
        state.applied.push(frame.seq)
      }
    })
    return { state, model }
  }

  function evt(seq: number, epoch = EPOCH): HostFrame {
    return {
      type: 'evt',
      seq,
      epoch,
      name: 'host.state',
      data: { state: 'ready', jobStatus: 'n/a' }
    }
  }

  function answer(page: Partial<SnapshotPage> & { seq: number }): IpcResult<SnapshotPage> {
    return {
      ok: true,
      value: { snapshotId: 'snap', epoch: EPOCH, chunks: [], ...page }
    }
  }

  it('[ADR-033] a read model applies an event only when its seq is above the last one applied', () => {
    const { state, model } = counter()
    model.applySnapshot({ seq: 5, data: { applied: [], snapshots: 0 } })
    model.applyEvent(evt(4))
    model.applyEvent(evt(5))
    model.applyEvent(evt(6))
    model.applyEvent(evt(6))
    expect(state.applied).toEqual([6])
    expect(model.seq).toBe(6)
  })

  it('[ADR-033] a paged snapshot is read to its last page before the buffered frames apply', async () => {
    const { state, model } = counter()
    let listener: ((frames: readonly HostFrame[]) => void) | null = null
    const requests: SnapshotParams[] = []
    const chunks: SnapshotChunk[][] = []
    const pages = [
      answer({ seq: 7, snapshotId: 'snap-7', next: 'page-2' }),
      answer({ seq: 7, snapshotId: 'snap-7' })
    ]
    const path: HostReadPath = {
      subscribe(follow) {
        listener = follow
        return () => {
          listener = null
        }
      },
      snapshot(params) {
        requests.push(params)
        // A frame newer than the snapshot arrives between the two pages.
        if (requests.length === 1) listener!([evt(8)])
        return Promise.resolve(pages[requests.length - 1])
      }
    }
    const follower = followHost(path, {
      model,
      sections: ['meta'],
      dataOf(read) {
        chunks.push([...read])
        return { applied: [], snapshots: 0 }
      },
      settled() {}
    })
    expect(await follower.start()).toBe(true)
    expect(requests).toEqual([{ sections: ['meta'] }, { snapshotId: 'snap-7', cursor: 'page-2' }])
    expect(chunks).toHaveLength(1)
    expect(state.applied).toEqual([8])
    follower.stop()
    expect(listener).toBeNull()
  })

  it('[ADR-033] a first snapshot that is refused leaves the follower stopped and the model untouched', async () => {
    const { state, model } = counter()
    let subscribed = false
    const path: HostReadPath = {
      subscribe() {
        subscribed = true
        return () => {
          subscribed = false
        }
      },
      snapshot: () =>
        Promise.resolve({ ok: false, error: { code: 'INTERNAL', message: 'no route' } })
    }
    const follower = followHost(path, {
      model,
      sections: ['meta'],
      dataOf: () => ({ applied: [], snapshots: 0 }),
      settled() {}
    })
    expect(await follower.start()).toBe(false)
    expect(subscribed).toBe(false)
    expect(state.snapshots).toBe(0)
  })
})
