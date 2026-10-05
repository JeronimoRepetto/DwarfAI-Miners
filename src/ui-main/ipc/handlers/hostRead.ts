// The Host read rows of seam A (14 §2.2 A-N01 `getHostSnapshot`, A-N02 `onHostEvent`: NEW, `host`, owner
// host/transport; ADR-003 items 6, 7; ADR-033 item 3): the read path of every Host-fed read model in the renderers.
//
// - A-N01 is a route target of the router (ADR-001 item 3), so every call has passed the seam A gate first, sender and
//   payload (`validate.ts`, ADR-019 items 7, 8). It is a 1:1 relay (14 §1.2): the renderer's `SnapshotParams` are the
//   B-M04 params, sent through `HostClient.snapshot`, and each page comes back unchanged as `IpcResult<SnapshotPage>`.
//   A first read and each continuation are one call each, so a renderer pages the snapshot itself (14 §4.2). A Host
//   call error (`SNAPSHOT_EXPIRED`, …) is the result's error branch, never a throw into the renderer (14 §1.5).
// - A-N02 is the one push every Host frame reaches renderers through (14 §1.2): `forwardHostEvents` takes the frames
//   `HostClient.subscribe` hands on — already in `seq` order, each newer than the last one applied (ADR-003 item 7,
//   window/ports/hostClient.ts) — and sends them to every mode window as `HostFrame[]` batches, in that order, at
//   most one batch per window per macrotask (14 §1.8): the frames of one macrotask are queued and sent together when
//   the next macrotask runs. A hidden window receives its batches too (ADR-025 D7). The client's `snapshot` events are
//   its own rehydration and are not frames: a renderer reads the snapshot through A-N01.
//
// The rows are born `host` in cut 1 and listed in `unrouted.ts` until the cut-1 switch (ISSUE-123) routes them and
// the root composes these parts; in a table without their routes the router refuses them like a channel with no route.
// A call of any other channel is refused, never guessed (14 §1.5). Nothing here logs: both rows carry sensitive Host
// data (14 §3.5 SENSITIVE_FRAMES, `session.snapshot` result).
import type {
  ChannelKey,
  EvtFrame,
  IpcError,
  IpcResult,
  SnapshotPage,
  SnapshotParams
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-N01 (invoke). */
export const HOST_SNAPSHOT = 'host:snapshot' satisfies ChannelKey
/** A-N02 (push), sent by `forwardHostEvents`. */
export const HOST_EVENT = 'host:event' satisfies ChannelKey
/** The invoke rows this target serves. */
export const HOST_READ_ROWS = [HOST_SNAPSHOT] as const

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : { code: 'INTERNAL', message: 'the snapshot relay failed', retryable: false }
}

export function createHostReadRows(client: Pick<HostClient, 'snapshot'>): RouteTarget {
  return {
    serve(channel, payload) {
      if (channel === HOST_SNAPSHOT) {
        return client.snapshot(payload as SnapshotParams).then(
          (page): IpcResult<SnapshotPage> => ({ ok: true, value: page }),
          (error: unknown): IpcResult<SnapshotPage> => ({ ok: false, error: ipcErrorOf(error) })
        )
      }
      const error: IpcError = {
        code: 'METHOD_NOT_FOUND',
        message: `no route for ${channel}`,
        retryable: false
      }
      return Promise.resolve({ ok: false, error })
    }
  }
}

/** A mode window as A-N02 reaches it. */
export interface HostEventWindow {
  send(channel: typeof HOST_EVENT, batch: EvtFrame[]): void
}

export interface ForwardHostEventsDeps {
  client: Pick<HostClient, 'subscribe'>
  /** The mode windows now, hidden ones included. */
  windows: () => readonly HostEventWindow[]
  /** Runs `run` in the next macrotask; production uses `setImmediate`. */
  defer?: (run: () => void) => void
}

/** Forwards the client's frames to every mode window as A-N02 batches; returns the stop. */
export function forwardHostEvents(deps: ForwardHostEventsDeps): () => void {
  const defer = deps.defer ?? ((run: () => void) => void setImmediate(run))
  let pending: EvtFrame[] = []
  let stopped = false
  const flush = (): void => {
    const batch = pending
    pending = []
    if (stopped || batch.length === 0) return
    for (const window of deps.windows()) window.send(HOST_EVENT, batch)
  }
  const unsubscribe = deps.client.subscribe((event) => {
    if (event.kind !== 'frame') return
    if (pending.length === 0) defer(flush)
    pending.push(event.frame)
  })
  return () => {
    stopped = true
    pending = []
    unsubscribe()
  }
}
