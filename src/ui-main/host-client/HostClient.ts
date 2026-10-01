// HostClient (05 §3.14; 16 §4.14.1): UI main's one way to the DwarfAI Host, over the local channel of ADR-003.
//
// Connections (ADR-003 item 12): one `notifier` connection for the process's life and one `ui` connection while at
// least one handler is subscribed (the window relay subscribes while a window is open), each a `HostChannel`. A role
// never changes on a live connection.
//
// - `ensureHost` (ADR-002 D4): the host launcher attaches to or spawns the Host (spawn gate, versioned copy, detached
//   start, readiness: hostLauncher/launcher.ts), then the client says `hello` on its `notifier` connection, and on its
//   `ui` connection when one is wanted; `connected` once the notifier's `hello.ok` arrived (`compat` when the Host's
//   `protocolVersion` differs, ADR-002 D8; the handshake itself is hostLauncher/upgradeFlow.ts's). A launcher
//   `unavailable` reason is the state's reason (ADR-002 D9). A Host that is reported but does not answer `hello` is
//   tried again on the reconnect schedule.
// - `ui` attach (ADR-003 items 7–8; 14 §1.9, §4.3): `events.subscribe` first, with `resume {epoch, lastSeq}` when the
//   Host's epoch is the one of the state already applied, then (unless the Host replays) the paged snapshot; what the
//   handlers receive is snapshotReader.ts's. A new epoch is always a fresh snapshot (no resume). A new subscriber
//   while attached gets a fresh snapshot too, so every handler starts from a whole board. A Host still `starting` or
//   `migrating` (HOST_NOT_READY, 14 §3.3) is waited for until its `host.state` frame reports it ready (UC-001).
// - `call` (14 §1.3, §1.6, §3.10): refused locally with NOT_SUPPORTED, and never sent, when `capabilities()` does not
//   list the method (`protocolVersion` is never a gate); a mutation (a call whose params carry a `requestId`) is
//   refused HOST_UNAVAILABLE while the state is not `connected` (ADR-002 D9) and is sent only on a `ui` connection:
//   the `notifier` never carries one, nor any method outside its scope (`ping`, `attention.clicked`, the names
//   sections of `session.snapshot`). Each call has its 14 §3.10 deadline: past it, TIMEOUT (retryable), and the
//   call is never re-sent.
// - A lost connection (closed without `host.closing`, or silent for 15 s, ADR-003 item 9) → `reconnecting`; the client
//   tries again after 250 ms, doubling to 5 s (ADR-002 D9), each time through the launcher, which respawns a Host
//   whose endpoint is gone. After it attached again, each in-flight mutation is re-sent once with the same
//   `requestId`: any of them on a hot reconnect (same epoch), only `conversation.send` and `asking.answer*` after a
//   new epoch (14 §1.6); every other in-flight call answers HOST_UNAVAILABLE (retryable) and the snapshot shows the
//   real state. The crash-loop rule, the hung-Host state and Retry are the connection-state machine's (later:
//   ISSUE-052).
// - `host.closing` (B-F05) before a close is DwarfAI's own stop: no reconnect; `onClosing` tells the composition
//   (the tray process exits with the Host, ADR-002 D7, later: ISSUE-053).
// - `withUiConnection`: the `ui` connection when one is open, else a short-lived one (same uiToken, `hello {role:
//   'ui'}`) closed when the work settled (OQ-47).
// - Logging: `host.connection` on every state change, with the state and reason as `causeClass` (19 §9.1); never a
//   frame's content, a token or a path (14 §1.10).
import type { Duplex } from 'node:stream'
import {
  isAdvertised,
  SNAPSHOT_SECTIONS,
  type Hello,
  type HostFrameData,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError,
  type SnapshotPage,
  type SnapshotParams,
  type SnapshotSection
} from '@dwarfai/contracts'
import type { UiLog } from '../diagnostics/uiLogger'
import type { EnsureHostResult } from '../hostLauncher/launcher'
import type {
  HostAvailability,
  HostClient,
  HostConnection,
  HostEvent,
  Presence
} from '../window/ports/hostClient'
import {
  openChannel,
  type CallAnswer,
  type ChannelDeps,
  type ClosingReason,
  type HostChannel
} from './channel'
import { deadlineOf } from './deadlines'
import { isMutation, resendAfterReconnect } from './requestIds'
import { SnapshotReader } from './snapshotReader'

/** ADR-002 D9: the first reconnect attempt after 250 ms, doubling up to 5 s. */
export const RECONNECT_FIRST_MS = 250
export const RECONNECT_MAX_MS = 5_000

export interface HostClientTimers {
  /** Epoch milliseconds. */
  now(): number
  /** Schedules `run` after `ms`; the answer cancels it. */
  after(ms: number, run: () => void): () => void
}

export interface HostClientDeps {
  /** ADR-002 D4: attach to or spawn the Host (hostLauncher/launcher.ts). */
  launcher: { ensureHostRunning(): Promise<EnsureHostResult> }
  /** Opens one connection to the Host's UI endpoint; rejects when nothing listens. */
  connect(): Promise<Duplex>
  /** The uiToken of `<hostDataDir>/run/ui.token`, read for each `hello`. */
  readToken(): Promise<string>
  protocolVersion: number
  /** This UI build, as `hello.client` describes it. */
  client: Hello['client']
  timers: HostClientTimers
  log: UiLog
}

/** A call the client refused or the Host answered with a call error (14 §1.5, §3.3). */
export class HostCallError extends Error {
  constructor(readonly error: IpcError) {
    super(`${error.code}: ${error.message}`)
    this.name = 'HostCallError'
  }
}

/** The port plus what UI main's composition root needs of the client itself. */
export interface HostClientService extends HostClient {
  /** The Host closed on purpose (`host.closing`): no reconnect follows. */
  onClosing(h: (reason: ClosingReason) => void): () => void
  /** Closes both connections and stops every timer; nothing reconnects after. */
  dispose(): void
}

/** The notifier scope of ADR-003 item 12 (14 §2.3 "Notifier scope"). */
const NOTIFIER_SECTIONS: ReadonlySet<string> = new Set(['mine-names', 'dwarf-names'])

const SUBSYSTEM = 'host-client'

interface Call {
  method: string
  params: unknown
  mutation: boolean
  resolve(result: unknown): void
  reject(error: HostCallError): void
  cancelDeadline(): void
  /** The connection it waits on and its correlation id there; null while it waits for a reconnect. */
  on: { channel: HostChannel; id: string } | null
  resent: boolean
}

const unavailable = (message: string): IpcError => ({
  code: 'HOST_UNAVAILABLE',
  message,
  retryable: true
})

export function createHostClient(deps: HostClientDeps): HostClientService {
  return new NodeHostClient(deps)
}

class NodeHostClient implements HostClientService {
  private connection: HostConnection = { state: 'connecting' }
  private notifier: HostChannel | null = null
  private ui: HostChannel | null = null
  private reader: SnapshotReader | null = null
  /** The epoch of the state the handlers hold, and the seq applied last in it. */
  private applied: { epoch: string; seq: number | null } | null = null
  private run: Promise<HostAvailability> | null = null
  private cancelWait: () => void = () => {}
  private disposed = false
  /** A `ui` hello is under way: a second attach waits for it instead of opening another connection. */
  private uiOpening = false
  private readonly calls = new Set<Call>()
  /** The calls waiting for their `res`, by correlation id. */
  private readonly pending = new Map<string, Call>()
  /** The client's own protocol requests (subscribe, snapshot pages) waiting for their `res`, by correlation id. */
  private readonly waiters = new Map<string, (answer: CallAnswer<unknown>) => void>()
  /** Connections the client closed itself: their close is not a loss. */
  private readonly retired = new WeakSet<HostChannel>()
  private readonly handlers = new Set<(e: HostEvent) => void>()
  private readonly stateListeners = new Set<(s: HostConnection) => void>()
  private readonly closingListeners = new Set<(reason: ClosingReason) => void>()
  private readonly channelDeps: ChannelDeps
  /** `hello.ok.capabilities` of the last connection: replaced on every reconnect, kept while reconnecting. */
  private advertised: readonly string[] = []

  constructor(private readonly deps: HostClientDeps) {
    this.channelDeps = {
      connect: deps.connect,
      readToken: deps.readToken,
      protocolVersion: deps.protocolVersion,
      client: deps.client,
      after: deps.timers.after,
      liveness: true
    }
  }

  // ---- the port ----

  ensureHost(): Promise<HostAvailability> {
    if (this.disposed) return Promise.resolve({ unavailable: 'spawn-failed' })
    if (this.connection.state === 'connected' && this.notifier?.open === true) {
      return Promise.resolve('available')
    }
    this.run ??= this.connectLoop().finally(() => {
      this.run = null
    })
    return this.run
  }

  state(): HostConnection {
    return this.connection
  }

  onStateChange(h: (s: HostConnection) => void): () => void {
    this.stateListeners.add(h)
    return () => this.stateListeners.delete(h)
  }

  capabilities(): readonly string[] {
    return this.advertised
  }

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    return this.callOn(null, method, params) as Promise<HostResult[M]>
  }

  snapshot(p: SnapshotParams): Promise<SnapshotPage> {
    return this.call('session.snapshot', this.advertisedSections(p, this.capabilities()))
  }

  subscribe(handler: (e: HostEvent) => void): () => void {
    this.handlers.add(handler)
    if (this.handlers.size === 1) {
      if (this.connection.state === 'connected' && this.ui === null) void this.attachUi()
    } else {
      this.reader?.refresh()
    }
    return () => {
      if (!this.handlers.delete(handler) || this.handlers.size > 0) return
      this.closeUi()
    }
  }

  reportPresence(_p: Presence): void {
    // B-M07 `presence` is born with the attention module's presence route (later: ISSUE-111); until the Host
    // advertises it, sending it would be a method the Host did not list (14 §1.3).
  }

  async withUiConnection<T>(
    work: (c: Pick<HostClient, 'call' | 'snapshot'>) => Promise<T>
  ): Promise<T> {
    if (this.ui !== null && this.ui.open) return work(this)
    const opened = await openChannel(this.channelDeps, 'ui')
    if (opened.kind !== 'open')
      throw new HostCallError(unavailable('no ui connection could be opened'))
    const channel = this.adopt(opened.channel)
    try {
      return await work({
        call: (method, params) => this.callOn(channel, method, params) as never,
        snapshot: (p) =>
          this.callOn(
            channel,
            'session.snapshot',
            this.advertisedSections(p, channel.helloOk.capabilities)
          ) as Promise<SnapshotPage>
      })
    } finally {
      this.retire(channel)
    }
  }

  // ---- the composition's ----

  onClosing(h: (reason: ClosingReason) => void): () => void {
    this.closingListeners.add(h)
    return () => this.closingListeners.delete(h)
  }

  dispose(): void {
    this.disposed = true
    this.cancelWait()
    this.closeUi()
    if (this.notifier !== null) this.retire(this.notifier)
    this.notifier = null
    for (const call of [...this.calls]) this.fail(call, unavailable('the client was disposed'))
  }

  // ---- connecting ----

  /** Attaches, trying again on the ADR-002 D9 schedule, until connected or the launcher reports unavailable. */
  private async connectLoop(): Promise<HostAvailability> {
    let delay = RECONNECT_FIRST_MS
    for (;;) {
      if (this.disposed) return { unavailable: 'spawn-failed' }
      const launched = await this.deps.launcher.ensureHostRunning()
      if (typeof launched === 'object') {
        this.setState({ state: 'unavailable', reason: launched.unavailable })
        return { unavailable: launched.unavailable }
      }
      if (await this.attachNotifier()) return 'available'
      await this.wait(delay)
      delay = Math.min(delay * 2, RECONNECT_MAX_MS)
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.cancelWait = this.deps.timers.after(ms, resolve)
    })
  }

  private async attachNotifier(): Promise<boolean> {
    const opened = await openChannel(this.channelDeps, 'notifier')
    if (opened.kind !== 'open' || this.disposed) {
      if (opened.kind === 'open') this.retire(opened.channel)
      return false
    }
    const channel = this.adopt(opened.channel)
    this.notifier = channel
    this.advertised = channel.helloOk.capabilities
    void channel.closed.then((reason) => this.lost(channel, reason))
    const { helloOk } = channel
    const epochChanged = this.applied !== null && this.applied.epoch !== helloOk.epoch
    this.setState({
      state: 'connected',
      hostVersion: helloOk.hostVersion,
      compat: helloOk.protocolVersion !== this.deps.protocolVersion
    })
    if (this.handlers.size > 0) await this.attachUi()
    this.resendInFlight(epochChanged)
    return true
  }

  /** The `ui` connection: hello, `events.subscribe` first, then replay or the paged snapshot. */
  private async attachUi(): Promise<void> {
    if (this.ui !== null || this.uiOpening || this.disposed) return
    this.uiOpening = true
    const opened = await openChannel(this.channelDeps, 'ui').finally(() => {
      this.uiOpening = false
    })
    // A refused or unanswered ui hello leaves the board as it is: the notifier's loss is what starts a reconnect.
    if (opened.kind !== 'open') return
    const channel = this.adopt(opened.channel)
    if (this.handlers.size === 0 || this.disposed || this.notifier === null) {
      this.retire(channel)
      return
    }
    this.ui = channel
    const { epoch } = channel.helloOk
    const sameEpoch = this.applied !== null && this.applied.epoch === epoch
    const lastSeq = sameEpoch ? (this.applied?.seq ?? null) : null
    const readiness = new HostReadiness(channel.helloOk.state)
    const reader: SnapshotReader = new SnapshotReader(
      {
        page: async (params) => {
          const answer = await this.request(channel, 'session.snapshot', params)
          return answer.ok ? { ok: true, page: answer.result as SnapshotPage } : answer
        },
        sections: () => this.advertisedSections({}, channel.helloOk.capabilities).sections,
        emit: (event) => {
          this.applied = {
            epoch,
            seq: event.kind === 'snapshot' ? event.snapshot.seq : event.frame.seq
          }
          for (const handler of [...this.handlers]) handler(event)
        },
        // A Host back in `starting` or `migrating` is waited for; any other refusal leaves the last whole board in
        // place: a Host that stops answering is the hung-Host state's (later: ISSUE-052), a lost connection the
        // reconnect's.
        failed: (error) => {
          if (error.code !== 'HOST_NOT_READY') return
          readiness.notReady()
          void readiness.ready().then((ready) => {
            if (ready) void reader.read()
          })
        }
      },
      epoch,
      lastSeq
    )
    this.reader = reader
    channel.events((frame) => {
      if (frame.name === 'host.state') {
        readiness.update((frame.data as HostFrameData['host.state']).state)
      }
      reader.frame(frame)
    })
    void channel.closed.then((reason) => {
      readiness.closed()
      this.lost(channel, reason)
    })
    const params = lastSeq === null ? {} : { resume: { epoch, lastSeq } }
    void this.subscribeWhenReady(channel, reader, readiness, params)
  }

  /**
   * `events.subscribe` first, then replay or the paged snapshot. UC-001: a Host still `starting` or `migrating`
   * answers HOST_NOT_READY (14 §3.3); the attach waits for the `host.state` frame that reports it ready (B-F04).
   */
  private async subscribeWhenReady(
    channel: HostChannel,
    reader: SnapshotReader,
    readiness: HostReadiness,
    params: HostParams['events.subscribe']
  ): Promise<void> {
    for (;;) {
      if (!(await readiness.ready())) return
      const subscribed = await this.request(channel, 'events.subscribe', params)
      if (!subscribed.ok) {
        if (subscribed.error.code !== 'HOST_NOT_READY') return
        readiness.notReady()
        continue
      }
      const status = (subscribed.result as HostResult['events.subscribe']).status
      if (status === 'replaying') reader.replay()
      else void reader.read()
      return
    }
  }

  private closeUi(): void {
    const channel = this.ui
    this.ui = null
    this.reader?.stop()
    this.reader = null
    if (channel !== null) this.retire(channel)
  }

  /** Closes a connection on purpose: its close is not a loss. */
  private retire(channel: HostChannel): void {
    this.retired.add(channel)
    channel.close()
  }

  /**
   * A connection closed. One the client closed itself is no loss; one the Host closed on purpose (`host.closing`)
   * ends the link without a reconnect (ADR-002 D7, D8: `connecting` until a Host is ensured again); any other is lost:
   * `reconnecting`, then the ADR-002 D9 schedule.
   */
  private lost(channel: HostChannel, reason: ClosingReason | null): void {
    const deliberate = this.retired.has(channel)
    if (channel === this.ui) {
      this.ui = null
      this.reader?.stop()
      this.reader = null
    }
    if (channel === this.notifier) this.notifier = null
    this.detachCalls(channel, !deliberate)
    if (deliberate || this.disposed || this.connection.state !== 'connected') return
    if (reason !== null) {
      // The notifier's marker is the one the tray process acts on (ADR-003 item 12).
      if (channel.role !== 'notifier') return
      this.closeUi()
      for (const call of [...this.calls]) this.fail(call, unavailable('the Host closed'))
      this.setState({ state: 'connecting' })
      for (const listener of [...this.closingListeners]) listener(reason)
      return
    }
    if (this.ui !== null) this.detachCalls(this.ui, true)
    this.closeUi()
    if (this.notifier !== null) this.retire(this.notifier)
    this.notifier = null
    this.setState({ state: 'reconnecting', since: this.deps.timers.now() })
    void this.wait(RECONNECT_FIRST_MS).then(() => this.ensureHost())
  }

  /**
   * The calls waiting on `channel` lose it: a mutation waits for a re-send after the reconnect when `keepMutations`
   * and it was not re-sent already (14 §1.6); every other call answers HOST_UNAVAILABLE.
   */
  private detachCalls(channel: HostChannel, keepMutations: boolean): void {
    for (const call of [...this.calls]) {
      if (call.on?.channel !== channel) continue
      this.pending.delete(call.on.id)
      call.on = null
      if (!keepMutations || !call.mutation || call.resent) {
        this.fail(call, unavailable('the connection was lost'))
      }
    }
  }

  /** 14 §1.6: each in-flight mutation once, with its requestId; the others answer HOST_UNAVAILABLE. */
  private resendInFlight(epochChanged: boolean): void {
    for (const call of [...this.calls]) {
      if (call.on !== null) continue
      if (!resendAfterReconnect(call.method, { epochChanged }) || this.ui === null) {
        this.fail(call, unavailable('the Host restarted before the call was answered'))
        continue
      }
      call.resent = true
      this.send(call, this.ui)
    }
  }

  // ---- calls ----

  private callOn(fixed: HostChannel | null, method: string, params: unknown): Promise<unknown> {
    const capabilities = fixed?.helloOk.capabilities ?? this.capabilities()
    if (!isAdvertised(capabilities, method)) {
      return Promise.reject(
        new HostCallError({
          code: 'NOT_SUPPORTED',
          message: 'the Host did not advertise this method',
          retryable: false
        })
      )
    }
    const mutation = isMutation(params)
    if (fixed === null && mutation && this.connection.state !== 'connected') {
      return Promise.reject(new HostCallError(unavailable('mutations wait for the connection')))
    }
    const channel = fixed ?? this.channelFor(method, params, mutation)
    if (channel === null) {
      return Promise.reject(new HostCallError(unavailable('no connection may carry this call')))
    }
    return new Promise((resolve, reject) => {
      const call: Call = {
        method,
        params,
        mutation: mutation && fixed === null,
        resolve,
        reject,
        cancelDeadline: () => {},
        on: null,
        resent: false
      }
      call.cancelDeadline = this.deps.timers.after(deadlineOf(method, params), () =>
        this.fail(call, {
          code: 'TIMEOUT',
          message: 'the call passed its deadline; the Host may still settle it',
          retryable: true
        })
      )
      this.calls.add(call)
      this.send(call, channel)
    })
  }

  /** The `ui` connection when one is open; the `notifier` only for its own scope and never a mutation. */
  private channelFor(method: string, params: unknown, mutation: boolean): HostChannel | null {
    if (method === 'attention.clicked') return this.notifier
    if (this.ui !== null && this.ui.open) return this.ui
    return !mutation && notifierMaySend(method, params) ? this.notifier : null
  }

  private send(call: Call, channel: HostChannel): void {
    if (
      channel.role === 'notifier' &&
      (call.mutation || !notifierMaySend(call.method, call.params))
    ) {
      this.fail(call, {
        code: 'FORBIDDEN',
        message: 'the notifier never carries this call',
        retryable: false
      })
      return
    }
    const id = channel.request(call.method, call.params, (reserved) => {
      call.on = { channel, id: reserved }
      this.pending.set(reserved, call)
    })
    if (id === null && (!call.mutation || call.resent)) {
      this.fail(call, unavailable('the connection was lost'))
    }
  }

  /** Routes every `res` of `channel` to its call or protocol request. */
  private adopt(channel: HostChannel): HostChannel {
    channel.responses((id, answer) => this.answered(channel, id, answer))
    return channel
  }

  private answered(channel: HostChannel, id: string, answer: CallAnswer<unknown>): void {
    const call = this.pending.get(id)
    if (call === undefined || call.on?.channel !== channel) {
      this.waiters.get(id)?.(answer)
      this.waiters.delete(id)
      return
    }
    this.pending.delete(id)
    this.calls.delete(call)
    call.cancelDeadline()
    if (answer.ok) call.resolve(answer.result)
    else call.reject(new HostCallError(answer.error))
  }

  /** A protocol request of the client itself (subscribe, snapshot pages): answered or refused, never thrown. */
  private request(
    channel: HostChannel,
    method: string,
    params: unknown
  ): Promise<CallAnswer<unknown>> {
    return new Promise((resolve) => {
      let cancel: () => void = () => {}
      const id = channel.request(method, params, (reserved) => {
        this.waiters.set(reserved, (answer) => {
          cancel()
          resolve(answer)
        })
      })
      if (id === null) {
        resolve({ ok: false, error: unavailable('the connection was lost') })
        return
      }
      if (!this.waiters.has(id)) return
      cancel = this.deps.timers.after(deadlineOf(method, params), () => {
        this.waiters.delete(id)
        resolve({
          ok: false,
          error: { code: 'TIMEOUT', message: 'deadline passed', retryable: true }
        })
      })
      void channel.closed.then(() => {
        if (!this.waiters.delete(id)) return
        cancel()
        resolve({ ok: false, error: unavailable('the connection was lost') })
      })
    })
  }

  private fail(call: Call, error: IpcError): void {
    if (!this.calls.delete(call)) return
    if (call.on !== null) this.pending.delete(call.on.id)
    call.on = null
    call.cancelDeadline()
    call.reject(new HostCallError(error))
  }

  /** `p` with only advertised sections on a first page (14 §4.4); a continuation names none. */
  private advertisedSections(p: SnapshotParams, capabilities: readonly string[]): SnapshotParams {
    if (p.snapshotId !== undefined || p.cursor !== undefined) return p
    const wanted: readonly SnapshotSection[] = p.sections ?? SNAPSHOT_SECTIONS
    return {
      ...p,
      sections: wanted.filter((section) => isAdvertised(capabilities, `section:${section}`))
    }
  }

  private setState(next: HostConnection): void {
    this.connection = next
    this.deps.log.record({
      level: next.state === 'unavailable' ? 'warn' : 'info',
      event: 'host.connection',
      subsystem: SUBSYSTEM,
      ...(next.state === 'connected'
        ? { outcome: 'ok' as const }
        : next.state === 'reconnecting'
          ? { outcome: 'degraded' as const }
          : next.state === 'unavailable'
            ? { outcome: 'failed' as const }
            : {}),
      causeClass: next.state === 'unavailable' ? `unavailable:${next.reason}` : next.state
    })
    for (const listener of [...this.stateListeners]) listener(next)
  }
}

/**
 * Whether the Host of one `ui` connection serves more than the protocol set: `hello.ok.state`, then each `host.state`
 * frame (B-F04). `ready` and `upgrade-pending` serve; `starting` and `migrating` answer HOST_NOT_READY (14 §3.3).
 */
class HostReadiness {
  private serving: boolean
  private isClosed = false
  private readonly waiting: Array<(ready: boolean) => void> = []

  constructor(state: HostFrameData['host.state']['state']) {
    this.serving = HostReadiness.serves(state)
  }

  private static serves(state: HostFrameData['host.state']['state']): boolean {
    return state === 'ready' || state === 'upgrade-pending'
  }

  /** True once the Host serves; false when the connection closed first. */
  ready(): Promise<boolean> {
    if (this.isClosed) return Promise.resolve(false)
    if (this.serving) return Promise.resolve(true)
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  update(state: HostFrameData['host.state']['state']): void {
    this.serving = HostReadiness.serves(state)
    if (this.serving) this.settle(true)
  }

  /** A call answered HOST_NOT_READY: the next `host.state` frame decides. */
  notReady(): void {
    this.serving = false
  }

  closed(): void {
    this.isClosed = true
    this.settle(false)
  }

  private settle(ready: boolean): void {
    for (const resolve of this.waiting.splice(0)) resolve(ready)
  }
}

/** The notifier's scope: `ping`, `attention.clicked`, `session.snapshot` of the names sections only (ADR-003 item 12). */
function notifierMaySend(method: string, params: unknown): boolean {
  if (method === 'ping' || method === 'attention.clicked') return true
  if (method !== 'session.snapshot') return false
  const sections = (params as SnapshotParams | null)?.sections
  return sections !== undefined && sections.every((section) => NOTIFIER_SECTIONS.has(section))
}
