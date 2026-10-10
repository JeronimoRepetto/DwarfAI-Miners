import {
  hostConnectionViewSchema,
  ipcResultSchema,
  snapshotPageSchema,
  type HostEpoch,
  type HostFrame,
  type SnapshotChunk,
  type SnapshotParams,
  type SnapshotSection
} from '@dwarfai/contracts'
import { watch } from 'vue'
import { useHostConnection } from './useHostConnection'

/*
 * The shape every Host-fed renderer singleton follows (ADR-033 item 3; 14 §4.3; 21 §6 row "Renderer root,
 * composables"): a read model of the Host's snapshot and frames, relayed by UI main over A-N01 `getHostSnapshot` and
 * A-N02 `onHostEvent`.
 *
 * - `createReadModel` is ADR-033's `ReadModel<S>`: a snapshot replaces the state whole and sets `seq`; an event is
 *   applied only when its `seq` is above the last one applied.
 * - `followHost` drives one over the read path (14 §4.3 rules 1–3): subscribe first, then read the snapshot page by
 *   page, buffering the frames that arrive meanwhile; after the last page, drop the buffered frames with
 *   `seq ≤ snapshot.seq` and apply the rest in order. `resync-required` (any reason) or a frame of another Host epoch
 *   keeps the last state on screen and reads a fresh snapshot, never a replay.
 * - A read that fails (the Host not attached yet, a refusal, a table that does not route A-N01) leaves the model as it
 *   was and the follower `stale`, still subscribed: never stopped. ADR-033 item 3: read models never drop facts while
 *   the Host is unreachable, and the store keeps today's feed until a snapshot is applied (`settled`). A stale model
 *   reads the snapshot again on the next sign the Host is there: a frame on A-N02, or A-N04 reporting `connected`.
 * - A-N04 reporting `connected` after any other state reads a fresh snapshot in every phase: the renderer does not see
 *   `hello.ok`, and a reconnect's may carry a new epoch (14 §4.3 rule 3). A push that lands while a read is on its way
 *   is followed by one more read, since that read may predate the attach.
 */

// As ADR-033 item 3 writes it, with the event type a parameter (its default is ADR-033's `{ seq: number }`)
export interface ReadModel<S, E extends { seq: number } = { seq: number }> {
  state: S // reactive(...) at module scope
  seq: number // last applied Host event
  applySnapshot(snapshot: { seq: number; data: S }): void
  applyEvent(event: E): void // ignored when seq <= this.seq
}

export interface ReadModelSpec<S, E extends { seq: number }> {
  state: S
  /** Replaces the state whole with a snapshot's data: never merged, nothing inferred from a difference. */
  replace(data: S): void
  /** Applies one event newer than the last one applied. */
  apply(event: E): void
}

export function createReadModel<S, E extends { seq: number }>(
  spec: ReadModelSpec<S, E>
): ReadModel<S, E> {
  const model: ReadModel<S, E> = {
    state: spec.state,
    seq: 0,
    applySnapshot(snapshot) {
      model.seq = snapshot.seq
      spec.replace(snapshot.data)
    },
    applyEvent(event) {
      if (event.seq <= model.seq) return
      model.seq = event.seq
      spec.apply(event)
    }
  }
  return model
}

/** The members of `window.api` a Host read model reads (A-N02, A-N01, A-N04). */
export interface HostReadPath {
  subscribe(listener: (frames: readonly HostFrame[]) => void): () => void
  snapshot(params: SnapshotParams): Promise<unknown>
  /** A-N04's pushes; the window's `useHostConnection` view when omitted. */
  connection?(listener: (view: unknown) => void): () => void
}

export interface HostFollowSpec<S> {
  model: ReadModel<S, HostFrame>
  /** The snapshot sections this model reads (14 §6.4). */
  sections: SnapshotSection[]
  /** The model's data from every chunk of one snapshot, all pages joined. */
  dataOf(chunks: readonly SnapshotChunk[]): S
  /** After a snapshot (and the buffered frames after it) or a batch of frames was applied. */
  settled(): void
}

export interface HostFollower {
  /**
   * Subscribes, then reads the first snapshot; answers whether the model is now fed by the Host. When it is not, the
   * follower stays subscribed and feeds the model once a later read succeeds (`settled` tells).
   */
  start(): Promise<boolean>
  stop(): void
}

const pageAnswerSchema = ipcResultSchema(snapshotPageSchema)

/**
 * A-N04 as the window's one follower of it holds it (`useHostConnection`, started by the shell): every Host-fed read
 * model hears the same connection the composer gates on, without a second subscription.
 */
function windowConnection(listener: (view: unknown) => void): () => void {
  return watch(
    () => useHostConnection().view.value,
    (view) => {
      if (view !== null) listener(view)
    },
    { flush: 'sync' }
  )
}

export function followHost<S>(path: HostReadPath, spec: HostFollowSpec<S>): HostFollower {
  let phase: 'idle' | 'syncing' | 'live' | 'stale' = 'idle'
  let unsubscribe: Array<() => void> = []
  let buffer: HostFrame[] = []
  let epoch: HostEpoch | null = null
  /** The last state A-N04 pushed; null until the first push. */
  let connection: string | null = null
  /** A-N04 reported `connected` while a read was on its way: read once more after it. */
  let again = false
  /** Bumped by `stop`, so a snapshot read before it is never applied after it. */
  let generation = 0

  async function readSnapshot(): Promise<{
    seq: number
    epoch: HostEpoch
    chunks: SnapshotChunk[]
  } | null> {
    const chunks: SnapshotChunk[] = []
    let params: SnapshotParams = { sections: spec.sections }
    for (;;) {
      let answered: unknown
      try {
        answered = await path.snapshot(params)
      } catch {
        return null
      }
      const parsed = pageAnswerSchema.safeParse(answered)
      if (!parsed.success || !parsed.data.ok) return null
      const page = parsed.data.value
      chunks.push(...(page.chunks as SnapshotChunk[]))
      if (page.next === undefined) return { seq: page.seq, epoch: page.epoch, chunks }
      params = { snapshotId: page.snapshotId, cursor: page.next }
    }
  }

  /** Applies frames in order until one asks for a fresh snapshot; the rest wait for it. */
  function apply(frames: readonly HostFrame[]): void {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]!
      if (frame.name === 'resync-required') {
        resync(frames.slice(index + 1))
        return
      }
      if (frame.epoch !== epoch) {
        // A new Host epoch: never a replay (14 §4.3 rule 3); the frame itself waits for the new snapshot.
        resync(frames.slice(index))
        return
      }
      spec.model.applyEvent(frame)
    }
    spec.settled()
  }

  function resync(pending: readonly HostFrame[]): void {
    phase = 'syncing'
    buffer = pending.filter((frame) => frame.name !== 'resync-required')
    void load(generation)
  }

  /** One A-N04 push: `connected` after any other state reads a fresh snapshot (14 §4.3 rule 3). */
  function connectionChanged(view: unknown): void {
    const parsed = hostConnectionViewSchema.safeParse(view)
    if (!parsed.success) return
    const previous = connection
    connection = parsed.data.state
    if (connection !== 'connected' || previous === 'connected') return
    if (phase === 'syncing') again = true
    else if (phase !== 'idle') resync([])
  }

  async function load(asked: number): Promise<boolean> {
    again = false
    const snapshot = await readSnapshot()
    if (asked !== generation) return false
    if (snapshot === null) {
      buffer = []
      phase = 'stale'
      if (again) resync([])
      return false
    }
    spec.model.applySnapshot({ seq: snapshot.seq, data: spec.dataOf(snapshot.chunks) })
    epoch = snapshot.epoch
    phase = 'live'
    // Frames of an earlier epoch are not this snapshot's; frames at or below its seq are in it already.
    const pending = buffer.filter((frame) => frame.epoch === snapshot.epoch)
    buffer = []
    if (again) {
      resync(pending)
      return true
    }
    apply(pending)
    return true
  }

  function stop(): void {
    for (const leave of unsubscribe.splice(0)) leave()
    generation += 1
    phase = 'idle'
    buffer = []
    epoch = null
    connection = null
    again = false
  }

  return {
    async start() {
      if (phase !== 'idle') return phase === 'live'
      phase = 'syncing'
      // Subscribe first, then read (ADR-033 item 3): a change between the two is never missed.
      unsubscribe = [
        path.subscribe((frames) => {
          if (phase === 'syncing') buffer.push(...frames)
          else if (phase === 'live') apply(frames)
          // A frame is the Host answering again: the snapshot first, then the frames newer than it.
          else if (phase === 'stale') resync(frames)
        }),
        (path.connection ?? windowConnection)(connectionChanged)
      ]
      return load(generation)
    },
    stop
  }
}
