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
      },
      connection: () => () => {}
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

  /** A scripted read path: A-N02 frames, A-N04 connection pushes, and A-N01 answering each answer in turn. */
  function scripted(answers: unknown[]) {
    let frames: ((frames: readonly HostFrame[]) => void) | null = null
    let connection: ((view: unknown) => void) | null = null
    const requests: SnapshotParams[] = []
    const path: HostReadPath = {
      subscribe(follow) {
        frames = follow
        return () => {
          frames = null
        }
      },
      snapshot(params) {
        requests.push(params)
        return Promise.resolve(answers[Math.min(requests.length - 1, answers.length - 1)])
      },
      connection(follow) {
        connection = follow
        return () => {
          connection = null
        }
      }
    }
    return {
      path,
      requests,
      push: (batch: HostFrame[]) => frames?.(batch),
      connect: (state: 'connecting' | 'connected' | 'reconnecting') => connection?.({ state }),
      following: () => frames !== null && connection !== null
    }
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }

  const NOT_ATTACHED = {
    ok: false,
    error: { code: 'HOST_UNAVAILABLE', message: 'not attached', retryable: true }
  }

  function follow(path: HostReadPath, model: ReturnType<typeof counter>['model']) {
    let settled = 0
    const follower = followHost(path, {
      model,
      sections: ['meta'],
      dataOf: () => ({ applied: [], snapshots: 0 }),
      settled() {
        settled += 1
      }
    })
    return { follower, settled: () => settled }
  }

  // AMENDED (was: "leaves the follower stopped"): a stopped follower never read again, so a read model whose first
  // read came before the Host attached stayed unfed for the window's life (the panel's endless "Reading…" note).
  it('[ADR-033] a first snapshot that is refused leaves the model untouched and the follower stale, still following', async () => {
    const { state, model } = counter()
    const host = scripted([{ ok: false, error: { code: 'INTERNAL', message: 'no route' } }])
    const { follower } = follow(host.path, model)
    expect(await follower.start()).toBe(false)
    expect(host.following()).toBe(true)
    expect(state.snapshots).toBe(0)
    follower.stop()
    expect(host.following()).toBe(false)
  })

  it('[ADR-033] a first snapshot read before the Host attached is read again when the Host connection reports connected', async () => {
    const { state, model } = counter()
    const host = scripted([NOT_ATTACHED, answer({ seq: 4 })])
    const { follower, settled } = follow(host.path, model)
    expect(await follower.start()).toBe(false)
    expect(state.snapshots).toBe(0)

    host.connect('connected')
    await settle()

    expect(host.requests).toHaveLength(2)
    expect(state.snapshots).toBe(1)
    expect(model.seq).toBe(4)
    expect(settled()).toBe(1)
    // Fed now: the frames after the snapshot apply.
    host.push([evt(5)])
    expect(state.applied).toEqual([5])
  })

  it('[ADR-033] a stale read model reads the snapshot again when a frame reaches it', async () => {
    const { state, model } = counter()
    const host = scripted([NOT_ATTACHED, answer({ seq: 4 })])
    const { follower } = follow(host.path, model)
    await follower.start()

    host.push([evt(5)])
    await settle()

    expect(host.requests).toHaveLength(2)
    expect(state.snapshots).toBe(1)
    // The frame that woke it is newer than the snapshot: it applies after it.
    expect(state.applied).toEqual([5])
  })

  it('[ADR-033] a live read model reads a fresh snapshot when the Host connection comes back connected, whose hello.ok may carry a new epoch', async () => {
    const { state, model } = counter()
    const host = scripted([answer({ seq: 4 }), answer({ seq: 9 })])
    const { follower } = follow(host.path, model)
    expect(await follower.start()).toBe(true)

    host.connect('reconnecting')
    await settle()
    expect(host.requests).toHaveLength(1)
    host.connect('connected')
    await settle()

    expect(host.requests).toHaveLength(2)
    expect(state.snapshots).toBe(2)
    expect(model.seq).toBe(9)
  })

  it('[ADR-033] a connection that reports connected while a snapshot is being read is followed by one more read', async () => {
    const { state, model } = counter()
    const host = scripted([NOT_ATTACHED, answer({ seq: 4 })])
    const { follower } = follow(host.path, model)
    const started = follower.start()
    // Connected arrives while the first read is still on its way: that read predates the attach.
    host.connect('connected')
    expect(await started).toBe(false)
    await settle()

    expect(host.requests).toHaveLength(2)
    expect(state.snapshots).toBe(1)
  })
})
