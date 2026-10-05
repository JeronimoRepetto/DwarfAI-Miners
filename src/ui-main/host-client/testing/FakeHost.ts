// FakeHost: the HostClient's double (16 §4.14 table; 17 §2.2), an in-process fake DwarfAI Host speaking the seam-B
// frames of ADR-003 items 4–9, 12 and 14 §3.2 over in-memory duplex pairs. Never imported by production code (R14).
//
// What it serves, as the Host's transport does (src/host/transport/**, which the UI tree may not import, R10):
// - the first frame: `hello` with this boot's token → `hello.ok` (its epoch, capabilities, a new clientId); a wrong
//   token → one `error {AUTH_FAILED}` and the close;
// - `ping`, `events.subscribe` (no resume → `live`; another epoch → `resync-required` and a `resync-required
//   {epoch-changed}` frame; a `lastSeq` its ring holds, on a connection that received no frame yet → `replaying` and
//   the missed frames; otherwise `resync-required {seq-not-in-ring}`), `session.snapshot` (the board's chunks, paged,
//   every page at the seq it was built at; a continuation of a dropped snapshot → SNAPSHOT_EXPIRED);
// - any other advertised method through `handle(method, fn)`, else `{}`; an unadvertised one → METHOD_NOT_FOUND; a
//   method outside the notifier scope on a notifier connection → FORBIDDEN;
// - frames: `publish(name, data)` numbers a frame on the one `ui` target (from 1 per epoch) and writes it to every
//   `ui` connection from `hello.ok` on; `host.closing` also reaches the notifiers. `publishToNotifiers(name, data)` numbers
//   a frame on the `notifier` target (its own seq, no ring: the notifier has no replay, 14 §2.3) and writes it to every
//   `notifier` connection, as the Host does with `attention.notify` / `attention.withdraw` (B-F22, B-F23).
// `crash()` drops every connection and refuses new ones; `restart()` brings a new boot with a new epoch.
import { duplexPair, type Duplex } from 'node:stream'
import {
  encodeFrame,
  FrameDecoder,
  helloSchema,
  type HelloOk,
  type IpcError,
  type IpcErrorCode,
  type SnapshotChunk,
  type SnapshotPage
} from '@dwarfai/contracts'

export type FakeRole = 'ui' | 'notifier'

/** Every frame a client sent after its hello, in arrival order. */
export interface ReceivedRequest {
  conn: number
  role: FakeRole
  id: string
  method: string
  params: unknown
  epoch: string
}

/** A handler's answer: a result, a call error, or a promise of either. */
export type FakeAnswer = unknown

export class FakeCallError {
  constructor(readonly error: IpcError) {}
}

/** The notifier scope (ADR-003 item 12; 14 §2.3). */
const NOTIFIER_METHODS = new Set(['ping', 'attention.clicked', 'session.snapshot'])

export const FAKE_HOST_TOKEN = 'f'.repeat(64)

/** The capabilities of a cut-0 Host plus what a test adds. */
export const FAKE_HOST_CAPABILITIES: readonly string[] = [
  'events.subscribe',
  'frame:host.closing',
  'frame:host.state',
  'frame:resync-required',
  'host.shutdown',
  'host.upgrade.request',
  'ping',
  'section:meta',
  'session.snapshot'
]

interface Connection {
  readonly no: number
  readonly server: Duplex
  role: FakeRole | null
  sentAny: boolean
  /** Frames that wait behind a subscribe result being written. */
  held: Array<{ seq: number; name: string; data: unknown }> | null
}

interface HeldSnapshot {
  conn: number
  snapshotId: string
  seq: number
  pages: SnapshotChunk[][]
  next: number
}

export interface FakeHostOptions {
  /**
   * The Host's side of liveness (ADR-003 item 9): a connection that sends no frame for `ms` is a detached client and is
   * closed without a frame, on the given (fake) timer.
   */
  dropSilentAfter?: { ms: number; after: (ms: number, run: () => void) => () => void }
  capabilities?: readonly string[]
  epoch?: string
  hostVersion?: string
  protocolVersion?: number
}

export class FakeHost {
  readonly token = FAKE_HOST_TOKEN
  readonly received: ReceivedRequest[] = []
  /** Every hello the Host accepted or refused, in order. */
  readonly hellos: Array<{ role: string; token: string; resume?: unknown }> = []
  epoch: string
  capabilities: string[]
  hostVersion: string
  protocolVersion: number
  /** The Host's lifecycle state: while `starting` or `migrating` every method but `ping` answers HOST_NOT_READY. */
  state: HelloOk['state'] = 'ready'
  /** The board `session.snapshot` serves, and how many chunks one page holds. */
  board: SnapshotChunk[] = [
    {
      section: 'meta',
      data: {
        hostVersion: '0.0.0-fake',
        state: 'ready',
        resetEpoch: 0,
        snapshotTail: 20,
        minesEverKnown: false
      }
    }
  ]
  pageSize = 1
  /** Runs before each snapshot page is answered (index from 0): a test publishes frames there. */
  beforePage: (index: number) => void = () => {}
  /** The next continuation of a snapshot answers SNAPSHOT_EXPIRED (held pages dropped). */
  expireNextContinuation = false
  /** A replay that starts this many frames before the resume's `lastSeq + 1` (a Host that sends some twice). */
  replayOverlap = 0
  /** Runs right after an `events.subscribe` answer and the frames that follow it were written. */
  afterSubscribe: () => void = () => {}

  private readonly connections = new Set<Connection>()
  private readonly handlers = new Map<string, (params: unknown) => FakeAnswer>()
  private readonly ring: Array<{ seq: number; name: string; data: unknown }> = []
  private readonly snapshots = new Map<string, HeldSnapshot>()
  private seq = 0
  private notifierSeq = 0
  private down = false
  private nextConn = 0
  private nextClient = 0
  private nextSnapshot = 0
  private boots = 1
  private readonly dropSilentAfter: FakeHostOptions['dropSilentAfter']

  constructor(options: FakeHostOptions = {}) {
    this.dropSilentAfter = options.dropSilentAfter
    this.epoch = options.epoch ?? 'epoch-1'
    this.capabilities = [...(options.capabilities ?? FAKE_HOST_CAPABILITIES)]
    this.hostVersion = options.hostVersion ?? '0.0.0-fake'
    this.protocolVersion = options.protocolVersion ?? 1
  }

  /** The client end of a new connection; rejects while the Host is down (nothing listens). */
  connect = async (): Promise<Duplex> => {
    if (this.down) throw new Error('nothing listens on the endpoint')
    const [client, server] = duplexPair()
    this.nextConn += 1
    const connection: Connection = {
      no: this.nextConn,
      server,
      role: null,
      sentAny: false,
      held: null
    }
    this.connections.add(connection)
    const decoder = new FrameDecoder()
    let cancelSilence: () => void = () => {}
    const heard = (): void => {
      cancelSilence()
      const silence = this.dropSilentAfter
      if (silence !== undefined) cancelSilence = silence.after(silence.ms, () => server.destroy())
    }
    heard()
    server.on('data', (chunk: Uint8Array) => {
      decoder.push(chunk)
      for (let next = decoder.next(); next !== null; next = decoder.next()) {
        if (next.kind !== 'frame') {
          server.destroy()
          return
        }
        heard()
        this.onFrame(connection, next.message)
      }
    })
    server.on('error', () => {})
    client.on('error', () => {})
    // An in-memory pair does not carry a close across (Node 24): each end closing closes the other, as a socket's
    // peer sees the connection end.
    server.once('close', () => {
      cancelSilence()
      this.connections.delete(connection)
      client.destroy()
    })
    client.once('close', () => server.destroy())
    return client
  }

  /** Serves `method` with `fn`; a `FakeCallError` it returns or throws is a call error. */
  handle(method: string, fn: (params: unknown) => FakeAnswer): void {
    this.handlers.set(method, fn)
  }

  /** Numbers a frame on the `ui` target and writes it to every `ui` connection (host.closing: notifiers too). */
  publish(name: string, data: unknown): number {
    this.seq += 1
    const entry = { seq: this.seq, name, data }
    this.ring.push(entry)
    for (const connection of this.connections) {
      if (connection.role === 'ui' || (connection.role === 'notifier' && name === 'host.closing')) {
        this.deliver(connection, entry)
      }
    }
    return this.seq
  }

  /** Numbers a frame on the `notifier` target and writes it to every `notifier` connection (14 §2.3, §2.4). */
  publishToNotifiers(name: string, data: unknown): number {
    this.notifierSeq += 1
    const entry = { seq: this.notifierSeq, name, data }
    for (const connection of this.connections) {
      if (connection.role === 'notifier') this.deliver(connection, entry)
    }
    return this.notifierSeq
  }

  /** The seq of the last frame numbered on the `ui` target. */
  currentSeq(): number {
    return this.seq
  }

  /** The live connections of a role. */
  liveConnections(role?: FakeRole): number {
    return [...this.connections].filter(
      (c) => c.role !== null && (role === undefined || c.role === role)
    ).length
  }

  /** The requests a role sent, method names only. */
  methods(role?: FakeRole): string[] {
    return this.received.filter((r) => role === undefined || r.role === role).map((r) => r.method)
  }

  /** The Host process dies: every connection drops, nothing listens until `restart()`. */
  crash(): void {
    this.down = true
    for (const connection of this.connections) connection.server.destroy()
    this.connections.clear()
  }

  /** A new boot: a new epoch, seq from 0, an empty ring, no snapshot held. */
  restart(epoch = `epoch-${(this.boots += 1)}`): void {
    this.down = false
    this.epoch = epoch
    this.seq = 0
    this.notifierSeq = 0
    this.ring.length = 0
    this.snapshots.clear()
  }

  /** The ring forgets every frame up to `seq`: a resume from before it is `resync-required {seq-not-in-ring}`. */
  forgetThrough(seq: number): void {
    while ((this.ring[0]?.seq ?? Infinity) <= seq) this.ring.shift()
  }

  /** A clean exit (ADR-002 D7): `host.closing {reason}` to every connection, then the close; nothing listens after. */
  closeCleanly(reason: 'stop-all' | 'upgrade' | 'os-session-end'): void {
    this.publish('host.closing', { reason, clean: true })
    this.down = true
    for (const connection of this.connections)
      connection.server.end(() => connection.server.destroy())
    this.connections.clear()
  }

  /** Drops one connection (a hot disconnect: same boot, same epoch). */
  dropConnections(role?: FakeRole): void {
    for (const connection of [...this.connections]) {
      if (role === undefined || connection.role === role) connection.server.destroy()
    }
  }

  private onFrame(connection: Connection, message: unknown): void {
    if (connection.role === null) {
      const hello = helloSchema.safeParse(message)
      if (!hello.success || hello.data.role === 'viewer') {
        this.refuse(connection, 'PROTOCOL_ERROR')
        return
      }
      this.hellos.push({
        role: hello.data.role,
        token: hello.data.token,
        ...(hello.data.resume === undefined ? {} : { resume: hello.data.resume })
      })
      if (hello.data.token !== this.token) {
        this.refuse(connection, 'AUTH_FAILED')
        return
      }
      connection.role = hello.data.role
      this.nextClient += 1
      const ok: HelloOk = {
        type: 'hello.ok',
        hostVersion: this.hostVersion,
        buildId: 'fake',
        protocolVersion: this.protocolVersion,
        endpointGeneration: 1,
        epoch: this.epoch,
        state: this.state,
        jobStatus: 'n/a',
        capabilities: [...this.capabilities],
        clientId: `client-${this.nextClient}`
      }
      this.write(connection, ok)
      return
    }
    const req = message as { type?: unknown; id?: unknown; method?: unknown; params?: unknown }
    if (req.type !== 'req' || typeof req.id !== 'string' || typeof req.method !== 'string') {
      connection.server.destroy()
      return
    }
    const { id, method, params } = req as { id: string; method: string; params: unknown }
    this.received.push({
      conn: connection.no,
      role: connection.role,
      id,
      method,
      params,
      epoch: this.epoch
    })
    if (!this.capabilities.includes(method)) {
      this.answerError(connection, id, 'METHOD_NOT_FOUND')
      return
    }
    if (connection.role === 'notifier' && !NOTIFIER_METHODS.has(method)) {
      this.answerError(connection, id, 'FORBIDDEN')
      return
    }
    if (method === 'ping') return this.answer(connection, id, { at: 0 })
    if (this.state === 'starting' || this.state === 'migrating') {
      this.answerError(connection, id, 'HOST_NOT_READY')
      return
    }
    if (method === 'events.subscribe') {
      this.subscribe(connection, id, params)
      this.afterSubscribe()
      return
    }
    if (method === 'session.snapshot') return this.snapshot(connection, id, params)
    const handler = this.handlers.get(method)
    let answer: FakeAnswer
    try {
      answer = handler === undefined ? {} : handler(params)
    } catch (error) {
      answer = error
    }
    void Promise.resolve(answer).then(
      (value) =>
        value instanceof FakeCallError
          ? this.write(connection, { type: 'res', id, ok: false, error: value.error })
          : this.answer(connection, id, value),
      (error: unknown) =>
        error instanceof FakeCallError
          ? this.write(connection, { type: 'res', id, ok: false, error: error.error })
          : this.answerError(connection, id, 'INTERNAL')
    )
  }

  private subscribe(connection: Connection, id: string, params: unknown): void {
    const resume = (params as { resume?: { epoch: string; lastSeq: number } }).resume
    if (resume === undefined) {
      this.answer(connection, id, { status: 'live', fromSeq: this.seq + 1 })
      return
    }
    const first = this.ring[0]?.seq ?? this.seq + 1
    const covered =
      resume.epoch === this.epoch && !connection.sentAny && resume.lastSeq >= first - 1
    if (covered) {
      connection.held = []
      this.answer(connection, id, {
        status: 'replaying',
        fromSeq: resume.lastSeq + 1,
        toSeq: this.seq
      })
      this.release(
        connection,
        this.ring.filter((entry) => entry.seq > resume.lastSeq - this.replayOverlap)
      )
      return
    }
    const reason = resume.epoch === this.epoch ? 'seq-not-in-ring' : 'epoch-changed'
    this.seq += 1
    const frame = { seq: this.seq, name: 'resync-required', data: { reason } }
    connection.held = []
    this.answer(connection, id, { status: 'resync-required' })
    this.release(connection, [frame])
  }

  private snapshot(connection: Connection, id: string, params: unknown): void {
    const p = params as { snapshotId?: string; cursor?: string }
    let held: HeldSnapshot | undefined
    if (p.snapshotId === undefined) {
      this.nextSnapshot += 1
      const pages: SnapshotChunk[][] = []
      for (let at = 0; at < this.board.length; at += this.pageSize) {
        pages.push(this.board.slice(at, at + this.pageSize))
      }
      if (pages.length === 0) pages.push([])
      held = {
        conn: connection.no,
        snapshotId: `${this.epoch}:snap-${this.nextSnapshot}`,
        seq: this.seq,
        pages,
        next: 0
      }
      this.snapshots.set(held.snapshotId, held)
    } else {
      held = this.snapshots.get(p.snapshotId)
      if (this.expireNextContinuation) {
        this.expireNextContinuation = false
        this.snapshots.delete(p.snapshotId)
        held = undefined
      }
      if (held === undefined || held.conn !== connection.no) {
        this.answerError(connection, id, 'SNAPSHOT_EXPIRED')
        return
      }
      if (p.cursor !== String(held.next)) {
        this.answerError(connection, id, 'INVALID_PARAMS')
        return
      }
    }
    const index = held.next
    this.beforePage(index)
    held.next += 1
    const last = held.next >= held.pages.length
    if (last) this.snapshots.delete(held.snapshotId)
    const page: SnapshotPage = {
      snapshotId: held.snapshotId,
      seq: held.seq,
      epoch: this.epoch,
      chunks: held.pages[index] ?? [],
      ...(last ? {} : { next: String(held.next) })
    }
    this.answer(connection, id, page)
  }

  private deliver(
    connection: Connection,
    entry: { seq: number; name: string; data: unknown }
  ): void {
    if (connection.held !== null) {
      connection.held.push(entry)
      return
    }
    connection.sentAny = true
    this.write(connection, {
      type: 'evt',
      seq: entry.seq,
      epoch: this.epoch,
      name: entry.name,
      data: entry.data
    })
  }

  private release(
    connection: Connection,
    first: Array<{ seq: number; name: string; data: unknown }>
  ): void {
    const waited = connection.held ?? []
    connection.held = null
    for (const entry of [...first, ...waited]) this.deliver(connection, entry)
  }

  private answer(connection: Connection, id: string, result: unknown): void {
    this.write(connection, { type: 'res', id, ok: true, result })
  }

  private answerError(connection: Connection, id: string, code: IpcErrorCode): void {
    this.write(connection, {
      type: 'res',
      id,
      ok: false,
      error: { code, message: code, retryable: false }
    })
  }

  private refuse(connection: Connection, code: string): void {
    connection.server.end(encodeFrame({ type: 'error', code }), () => connection.server.destroy())
  }

  private write(connection: Connection, frame: unknown): void {
    if (!connection.server.destroyed) connection.server.write(encodeFrame(frame))
  }
}
