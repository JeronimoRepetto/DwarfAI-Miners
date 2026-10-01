// The rehydration half of HostClient on one `ui` connection (ADR-003 items 7–8, frozen; 14 §1.9, §4.2, §4.3; 07
// S12.B01, S12.B05, S12.B08): what `subscribe` handlers receive.
//
// - From `hello.ok` on, every `evt` frame of the connection is buffered until the client knows where to start
//   (`awaiting`): the result of `events.subscribe`, which the client asks first.
// - `replaying` (a hot reconnect whose `lastSeq` the Host's ring still holds): the buffered and the following frames
//   are applied in order, each only when its `seq` is greater than the last one applied, so after a resume no frame
//   is applied twice and none is applied past a gap the Host did not replay.
// - Otherwise (`live` on a first attach or a new epoch, `resync-required`): `read()` pages `session.snapshot` from its
//   first page with only the advertised sections. Every page must carry the first page's `seq` and `snapshotId`;
//   SNAPSHOT_EXPIRED (or a page of another snapshot) starts again from the first page. Frames keep being buffered
//   while the pages arrive. Once the last page arrived, the snapshot is handed on as one `SnapshotPage` holding every
//   chunk (14 §4.2: applied only when every page arrived, so a handler never sees a partial board), then the buffered
//   frames with `seq ≤ S` are dropped and the rest applied in order.
// - A `resync-required` frame that is applied (any reason, 14 §4.3 rule 2) is not handed on: it starts a new read,
//   and the frames after it are buffered again. The next snapshot replaces the state; nothing is inferred from a
//   difference between two snapshots (no walk-out, ADR-033; 14 §4.3 rule 6).
// - A frame of another epoch than the connection's is never applied (14 §4.3 rule 3).
import type {
  EvtFrame,
  IpcError,
  SnapshotChunk,
  SnapshotPage,
  SnapshotParams
} from '@dwarfai/contracts'
import type { HostEvent } from '../window/ports/hostClient'

/** One page read: the page, or the call error that refused it (14 §1.5). */
export type PageAnswer = { ok: true; page: SnapshotPage } | { ok: false; error: IpcError }

export interface SnapshotReaderDeps {
  /** Reads one `session.snapshot` page on the connection. */
  page(params: SnapshotParams): Promise<PageAnswer>
  /** The sections to request on a first page: the advertised ones (14 §4.4). */
  sections(): SnapshotParams['sections']
  /** Where every applied snapshot and frame goes. */
  emit(event: HostEvent): void
  /** A read that could not finish (the connection was lost or refused it): the client reconnects or re-reads. */
  failed(error: IpcError): void
}

type Mode = 'awaiting' | 'reading' | 'live' | 'stopped'

export class SnapshotReader {
  private mode: Mode = 'awaiting'
  private buffer: EvtFrame[] = []
  private readSerial = 0

  /**
   * @param epoch the connection's `hello.ok.epoch`
   * @param lastSeq the seq of the last snapshot or frame applied in this epoch, or null when nothing was
   */
  constructor(
    private readonly deps: SnapshotReaderDeps,
    readonly epoch: string,
    private lastSeq: number | null
  ) {}

  /** The seq of the last snapshot or frame applied in this epoch; null before the first snapshot. */
  get appliedSeq(): number | null {
    return this.lastSeq
  }

  /** One `evt` frame of the connection, in arrival order. */
  frame(frame: EvtFrame): void {
    if (this.mode === 'stopped' || frame.epoch !== this.epoch) return
    if (this.mode === 'live') this.apply(frame)
    else this.buffer.push(frame)
  }

  /** `events.subscribe` answered `replaying`: the missed frames follow, then the live ones. */
  replay(): void {
    if (this.mode === 'stopped') return
    this.mode = 'live'
    this.drain()
  }

  /** Reads a whole snapshot, then applies the buffered frames newer than it. */
  async read(): Promise<void> {
    if (this.mode === 'stopped') return
    this.mode = 'reading'
    this.readSerial += 1
    const serial = this.readSerial
    for (;;) {
      const snapshot = await this.readPages()
      // A stop or a newer read while the pages arrived wins over this one.
      if (this.isStopped() || serial !== this.readSerial) return
      if (snapshot === 'restart') continue
      if (!snapshot.ok) {
        this.mode = 'awaiting'
        this.deps.failed(snapshot.error)
        return
      }
      this.lastSeq = snapshot.page.seq
      this.deps.emit({ kind: 'snapshot', snapshot: snapshot.page })
      this.mode = 'live'
      this.drain()
      return
    }
  }

  /**
   * A fresh whole snapshot for a handler that joined: read now when live; a read under way, or the one that follows
   * the subscribe result, already brings one (the subscribe still comes first).
   */
  refresh(): void {
    if (this.mode === 'live') void this.read()
  }

  /** The connection closed: nothing more is applied. */
  stop(): void {
    this.mode = 'stopped'
    this.buffer = []
  }

  private isStopped(): boolean {
    return this.mode === 'stopped'
  }

  private async readPages(): Promise<'restart' | PageAnswer> {
    const first = await this.deps.page({ sections: this.deps.sections() })
    if (!first.ok) return first
    const chunks: SnapshotChunk[] = [...first.page.chunks]
    let next = first.page.next
    while (next !== undefined) {
      const page = await this.deps.page({ snapshotId: first.page.snapshotId, cursor: next })
      if (!page.ok) return page.error.code === 'SNAPSHOT_EXPIRED' ? 'restart' : page
      // 14 §4.2: every page of one snapshot carries its seq and snapshotId.
      if (page.page.snapshotId !== first.page.snapshotId || page.page.seq !== first.page.seq) {
        return 'restart'
      }
      chunks.push(...page.page.chunks)
      next = page.page.next
    }
    const { snapshotId, seq, epoch } = first.page
    return { ok: true, page: { snapshotId, seq, epoch, chunks } }
  }

  /** Applies the buffered frames in order until one starts a new read. */
  private drain(): void {
    const frames = this.buffer
    this.buffer = []
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index] as EvtFrame
      this.apply(frame)
      if (this.mode !== 'live') {
        this.buffer.push(...frames.slice(index + 1))
        return
      }
    }
  }

  private apply(frame: EvtFrame): void {
    if (this.lastSeq !== null && frame.seq <= this.lastSeq) return
    this.lastSeq = frame.seq
    if (frame.name === 'resync-required') {
      void this.read()
      return
    }
    this.deps.emit({ kind: 'frame', frame })
  }
}
