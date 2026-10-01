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
// - The state is the 12B machine's (connectionMachine.ts; 07 §12B; ADR-002 D9): the client feeds it what happened
//   (a `hello.ok`, a frame, a loss, an attempt that found the endpoint bound or gone, a timer, the person's retry) and
//   runs the actions it answers. `state()` is ADR-002 D9's `HostConnection`; the Electron-main-only `retrying` shows
//   as `unavailable{unresponsive}`.
// - A lost connection (closed without `host.closing`, or silent for 15 s, ADR-003 item 9) → `reconnecting`; the client
//   tries the endpoint again after 250 ms, doubling to 5 s (ADR-002 D9). An attempt that finds nothing listening is a
//   Host crash: the launcher respawns it at once, silently (S12.19), a respawn that fails being one more crash; the
//   third Host crash within 5 minutes is `unavailable{crash-loop}` and nothing respawns until the person's retry
//   (S12.20, S12.B06). An attempt that finds the endpoint bound but silent keeps trying; 60 s without any frame from the
//   Host is `unavailable{unresponsive}` (ADR-003 item 9, S12.B09, S12.B10). After it attached again, each in-flight
//   mutation is re-sent once with the same `requestId`: any of them on a hot reconnect (same epoch), only
//   `conversation.send` and `asking.answer*` after a new epoch (14 §1.6); every other in-flight call answers
//   HOST_UNAVAILABLE (retryable) and the snapshot shows the real state.
// - `ensureHost` while `unavailable` is the person's retry (14 A-N05; S12.B07): a new attach through the launcher. For
//   a hung Host it is ADR-002 D9's Retry (S12.B11–S12.B15): one `hello` with its 5 s budget; unanswered, the launcher's
//   identity-checked end of that one Host process (hostLauncher/hungHost.ts), logged as `host.hung-end` (19 §9.1),
//   then a respawn when it was ended, counted as one Host crash; nothing is signalled when the identity does not match.
//   `generation-restart` has no retry (S12.B16, dormant in v1).
// - `wake` (Electron `powerMonitor` `resume`, 13 FM-109): a clock that jumped past the 15 s silence is a lost
//   connection at once; otherwise the client pings now.
// - `host.closing` (B-F05) before a close is DwarfAI's own stop: no reconnect; `onClosing` tells the composition
//   (the tray process exits with the Host, ADR-002 D7, later: ISSUE-053).
// - `withUiConnection`: the `ui` connection when one is open, else a short-lived one (same uiToken, `hello {role:
//   'ui'}`) closed when the work settled (OQ-47).
// - Logging: `host.connection` on every 12B transition, with the state and reason as `causeClass` (19 §9.1); never a
//   frame's content, a token, a pid or a path (14 §1.10).
import type { Duplex } from 'node:stream'
import {
  isAdvertised,
  SNAPSHOT_SECTIONS,
  type Hello,
  type HelloOk,
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
import type { HungHostEnd } from '../hostLauncher/hungHost'
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
import {
  HOST_UNRESPONSIVE_MS,
  initialMachine,
  step,
  wireState,
  type ConnectionAction,
  type ConnectionEvent,
  type ConnectionMachine
} from './connectionMachine'
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
  /** ADR-002 D9 steps 2 and 4: the host launcher's identity-checked end of a hung Host (hostLauncher/hungHost.ts). */
  hungHost: { endHungHost(): Promise<HungHostEnd> }
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
  /** The Host's lifecycle and job status from the current connection's `hello.ok` (14 §3.8), or null. */
  hostFacts(): { hostState: HelloOk['state']; jobStatus: HelloOk['jobStatus'] } | null
  /** Electron `powerMonitor` `resume` (13 FM-109): ping at once. */
  wake(): void
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

/** What one attempt at the notifier `hello` found. */
type Attempt = 'open' | { bound: boolean }

/** 19 §9.1 `host.hung-end`: the outcome name as `causeClass`, the record's own outcome class beside it. */
const HUNG_END_OUTCOME = {
  attached: 'ok',
  ended: 'ok',
  'identity-missing': 'skipped',
  'identity-mismatch': 'skipped',
  'end-failed': 'failed'
} as const

const unavailable = (message: string): IpcError => ({
  code: 'HOST_UNAVAILABLE',
  message,
  retryable: true
})

export function createHostClient(deps: HostClientDeps): HostClientService {
  return new NodeHostClient(deps)
}

class NodeHostClient implements HostClientService {
  private machine: ConnectionMachine
  private notifier: HostChannel | null = null
  private ui: HostChannel | null = null
  private reader: SnapshotReader | null = null
  /** The epoch of the state the handlers hold, and the seq applied last in it. */
  private applied: { epoch: string; seq: number | null } | null = null
  private run: Promise<HostAvailability> | null = null
  /** The number of the run `run` is. */
  private runOf = 0
  /** Bumped by every new run: a run whose number is no longer current stops at its next step. */
  private runNo = 0
  private cancelWait: () => void = () => {}
  private cancelUnresponsive: () => void = () => {}
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
  /** The Host's lifecycle and job status: the notifier's `hello.ok`, then each `host.state` frame. */
  private facts: { hostState: HelloOk['state']; jobStatus: HelloOk['jobStatus'] } | null = null

  constructor(private readonly deps: HostClientDeps) {
    this.machine = initialMachine(deps.timers.now())
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
    const now = this.state()
    if (now.state === 'connected' && this.notifier?.open === true) {
      return Promise.resolve('available')
    }
    if (now.state === 'unavailable') {
      // The person's retry (S12.B07, S12.B11); none for `generation-restart` (S12.B16).
      if (this.dispatch({ kind: 'retry' }).length === 0) {
        return Promise.resolve({ unavailable: now.reason })
      }
      return this.startRun()
    }
    return this.run ?? this.startRun()
  }

  state(): HostConnection {
    return wireState(this.machine)
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
      if (this.state().state === 'connected' && this.ui === null) void this.attachUi()
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

  hostFacts(): { hostState: HelloOk['state']; jobStatus: HelloOk['jobStatus'] } | null {
    return this.state().state === 'connected' ? this.facts : null
  }

  wake(): void {
    const notifier = this.notifier
    if (this.disposed || notifier === null || this.state().state !== 'connected') return
    // Only a Host that can be pinged is held to the silence bound (ADR-003 item 9; channel.ts).
    if (isAdvertised(notifier.helloOk.capabilities, 'ping')) {
      this.act(this.dispatch({ kind: 'tick' }))
      if (this.state().state !== 'connected') return
    }
    this.act(this.dispatch({ kind: 'power-resume' }))
  }

  dispose(): void {
    this.disposed = true
    this.runNo += 1
    this.cancelWait()
    this.cancelUnresponsive()
    this.closeUi()
    if (this.notifier !== null) this.retire(this.notifier)
    this.notifier = null
    for (const call of [...this.calls]) this.fail(call, unavailable('the client was disposed'))
  }

  // ---- connecting ----

  /** A new run for the state now; any older run stops at its next step. */
  private startRun(): Promise<HostAvailability> {
    const no = (this.runNo += 1)
    const run: Promise<HostAvailability> = this.drive(no).finally(() => {
      if (this.run === run) this.run = null
    })
    this.run = run
    this.runOf = no
    return run
  }

  private drive(no: number): Promise<HostAvailability> {
    switch (this.machine.state.state) {
      case 'retrying':
        return this.hungRetry(no)
      case 'reconnecting':
        return this.reconnectLoop(no)
      default:
        return this.connectLoop(no)
    }
  }

  /** Whether run `no` must stop: disposed, replaced by a newer run, or the state left `inState`. */
  private stopped(no: number, inState: ConnectionMachine['state']['state']): boolean {
    return this.disposed || no !== this.runNo || this.machine.state.state !== inState
  }

  /** What run `no` answers once it stopped: a newer run's answer, else the state now (never its own promise). */
  private settled(no: number): Promise<HostAvailability> | HostAvailability {
    if (this.run !== null && this.runOf !== no && !this.disposed) return this.run
    const now = this.state()
    if (now.state === 'connected') return 'available'
    return { unavailable: now.state === 'unavailable' ? now.reason : 'spawn-failed' }
  }

  /**
   * `connecting` (S12.B01–S12.B03, S12.B10): attach through the launcher, trying again on the ADR-002 D9 schedule,
   * until connected or unavailable. A launcher `spawn-failed` while the endpoint is bound but silent is not B03's: the
   * attempts go on until the hung-Host bound.
   */
  private async connectLoop(no: number): Promise<HostAvailability> {
    let delay = RECONNECT_FIRST_MS
    this.armUnresponsive()
    for (;;) {
      if (this.stopped(no, 'connecting')) return this.settled(no)
      const launched = await this.deps.launcher.ensureHostRunning()
      if (this.stopped(no, 'connecting')) return this.settled(no)
      if (typeof launched === 'object' && launched.unavailable !== 'spawn-failed') {
        this.dispatch({ kind: 'launch-unavailable', reason: launched.unavailable })
        return this.settled(no)
      }
      const attempt = await this.attachNotifier()
      if (attempt === 'open') return 'available'
      if (this.stopped(no, 'connecting')) return this.settled(no)
      if (typeof launched === 'object' && !attempt.bound) {
        this.dispatch({ kind: 'launch-unavailable', reason: 'spawn-failed' })
        return this.settled(no)
      }
      this.dispatch({ kind: 'endpoint', bound: attempt.bound })
      await this.wait(delay)
      delay = Math.min(delay * 2, RECONNECT_MAX_MS)
    }
  }

  /**
   * `reconnecting` (S12.B04–S12.B06, S12.B09; S12.19, S12.20): the endpoint again on the ADR-002 D9 schedule. An
   * attempt that finds nothing listening is a Host crash and the launcher respawns it at once; a respawn that fails is
   * one more crash. The machine says when respawning stops (crash-loop) and when a silent Host is unresponsive.
   */
  private async reconnectLoop(no: number): Promise<HostAvailability> {
    let delay = RECONNECT_FIRST_MS
    this.armUnresponsive()
    for (;;) {
      await this.wait(delay)
      delay = Math.min(delay * 2, RECONNECT_MAX_MS)
      if (this.stopped(no, 'reconnecting')) return this.settled(no)
      let attempt = await this.attachNotifier()
      for (;;) {
        if (attempt === 'open') return 'available'
        if (this.stopped(no, 'reconnecting')) return this.settled(no)
        const actions = this.dispatch({ kind: 'endpoint', bound: attempt.bound })
        if (!actions.some((action) => action.kind === 'respawn')) break
        const launched = await this.deps.launcher.ensureHostRunning()
        if (this.stopped(no, 'reconnecting')) return this.settled(no)
        if (typeof launched === 'object') {
          if (launched.unavailable !== 'spawn-failed') {
            this.dispatch({ kind: 'launch-unavailable', reason: launched.unavailable })
            return this.settled(no)
          }
          // The respawned Host died or never got ready: one more Host crash.
          attempt = { bound: false }
          continue
        }
        attempt = await this.attachNotifier()
      }
      if (this.stopped(no, 'reconnecting')) return this.settled(no)
    }
  }

  /**
   * ADR-002 D9's Retry of a hung Host (S12.B11–S12.B15): one `hello` with its 5 s budget (the hello bound of
   * channel.ts); unanswered, the launcher's identity-checked end, then a respawn when that one process was ended.
   */
  private async hungRetry(no: number): Promise<HostAvailability> {
    const startedAt = this.deps.timers.now()
    const attempt = await this.attachNotifier()
    if (attempt === 'open') {
      this.logHungEnd('attached', startedAt)
      return 'available'
    }
    if (this.stopped(no, 'retrying')) return this.settled(no)
    const end = await this.deps.hungHost
      .endHungHost()
      .catch((): HungHostEnd => ({ outcome: 'end-failed', errCode: 'signal-failed' }))
    this.logHungEnd(end.outcome, startedAt, end.outcome === 'end-failed' ? end.errCode : undefined)
    if (this.stopped(no, 'retrying')) return this.settled(no)
    const actions = this.dispatch({ kind: 'retry-unanswered', hungEnd: end.outcome })
    if (actions.some((action) => action.kind === 'respawn')) return this.connectLoop(no)
    return this.settled(no)
  }

  private logHungEnd(
    outcome: keyof typeof HUNG_END_OUTCOME,
    startedAt: number,
    errCode?: string
  ): void {
    this.deps.log.record({
      level: 'warn',
      event: 'host.hung-end',
      subsystem: SUBSYSTEM,
      outcome: HUNG_END_OUTCOME[outcome],
      causeClass: outcome,
      ...(errCode === undefined ? {} : { errCode }),
      durationMs: this.deps.timers.now() - startedAt
    })
  }

  /** Waits `ms`; an interrupted wait ends at once. */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = this.deps.timers.after(ms, resolve)
      this.cancelWait = () => {
        cancel()
        resolve()
      }
    })
  }

  /** The hung-Host bound of the attach under way: a `tick` HOST_UNRESPONSIVE_MS after the last frame. */
  private armUnresponsive(): void {
    this.cancelUnresponsive()
    const { state } = this.machine.state
    if (state !== 'connecting' && state !== 'reconnecting') return
    const due = Math.max(0, this.machine.quietSince + HOST_UNRESPONSIVE_MS - this.deps.timers.now())
    this.cancelUnresponsive = this.deps.timers.after(due, () => {
      this.dispatch({ kind: 'tick' })
      this.armUnresponsive()
    })
  }

  /** One attempt at the notifier `hello`; a connection that answers while no attach is wanted is closed again. */
  private async attachNotifier(): Promise<Attempt> {
    const opened = await openChannel(this.channelDeps, 'notifier')
    if (opened.kind !== 'open') return { bound: opened.kind === 'refused' || opened.bound }
    const { state } = this.machine.state
    if (
      this.disposed ||
      (state !== 'connecting' && state !== 'reconnecting' && state !== 'retrying')
    ) {
      this.retire(opened.channel)
      return { bound: true }
    }
    const channel = this.adopt(opened.channel)
    this.notifier = channel
    this.advertised = channel.helloOk.capabilities
    channel.heard(() => this.heard(channel))
    void channel.closed.then((reason) => this.lost(channel, reason))
    const { helloOk } = channel
    this.facts = { hostState: helloOk.state, jobStatus: helloOk.jobStatus }
    const epochChanged = this.applied !== null && this.applied.epoch !== helloOk.epoch
    this.dispatch({
      kind: 'hello-ok',
      hostVersion: helloOk.hostVersion,
      compat: helloOk.protocolVersion !== this.deps.protocolVersion
    })
    if (this.handlers.size > 0) await this.attachUi()
    this.resendInFlight(epochChanged)
    return 'open'
  }

  /** A frame from the Host on a connection the client holds (the hung-Host bound counts from the last one). */
  private heard(channel: HostChannel): void {
    if (channel === this.notifier || channel === this.ui) this.dispatch({ kind: 'frame' })
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
        // place: a Host that stops answering is the hung-Host state's, a lost connection the reconnect's.
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
    channel.heard(() => this.heard(channel))
    channel.events((frame) => {
      if (frame.name === 'host.state') {
        const data = frame.data as HostFrameData['host.state']
        readiness.update(data.state)
        this.facts = { hostState: data.state, jobStatus: data.jobStatus }
      }
      // S12.B08: the reader takes the fresh snapshot itself (snapshotReader.ts).
      if (frame.name === 'resync-required') this.dispatch({ kind: 'events-lost' })
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
    if (deliberate || this.disposed || this.state().state !== 'connected') return
    if (reason !== null) {
      // The notifier's marker is the one the tray process acts on (ADR-003 item 12).
      if (channel.role !== 'notifier') return
      this.closeUi()
      for (const call of [...this.calls]) this.fail(call, unavailable('the Host closed'))
      this.dispatch({ kind: 'closing' })
      for (const listener of [...this.closingListeners]) listener(reason)
      return
    }
    this.act(this.dispatch({ kind: 'lost' }))
  }

  /** Runs what the machine asked for that is not part of the run under way. */
  private act(actions: readonly ConnectionAction[]): void {
    for (const action of actions) {
      if (action.kind === 'reconnect') this.reconnect()
      if (action.kind === 'ping') {
        this.notifier?.pingNow()
        this.ui?.pingNow()
      }
    }
  }

  /** S12.B04: the connections go; in-flight mutations wait for the re-send; the reconnect run starts. */
  private reconnect(): void {
    if (this.ui !== null) this.detachCalls(this.ui, true)
    this.closeUi()
    if (this.notifier !== null) {
      this.detachCalls(this.notifier, true)
      this.retire(this.notifier)
    }
    this.notifier = null
    void this.startRun()
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
    if (fixed === null && mutation && this.state().state !== 'connected') {
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

  /**
   * Feeds the machine one event: each 12B transition is logged (`host.connection`, 19 §9.1), each change of the wire
   * state reaches the listeners, and a state that leaves the attach under way stops its timers.
   */
  private dispatch(event: ConnectionEvent): ConnectionAction[] {
    const before = this.state()
    const next = step(this.machine, event, this.deps.timers.now())
    this.machine = next.machine
    const after = this.state()
    const { state } = this.machine.state
    if (state !== 'connecting' && state !== 'reconnecting') this.cancelUnresponsive()
    if (state === 'unavailable') this.cancelWait()
    if (next.transition !== null) {
      this.deps.log.record({
        level: after.state === 'unavailable' ? 'warn' : 'info',
        event: 'host.connection',
        subsystem: SUBSYSTEM,
        ...(after.state === 'connected'
          ? { outcome: 'ok' as const }
          : after.state === 'reconnecting'
            ? { outcome: 'degraded' as const }
            : after.state === 'unavailable'
              ? { outcome: 'failed' as const }
              : {}),
        causeClass:
          state === 'retrying'
            ? 'retrying'
            : after.state === 'unavailable'
              ? `unavailable:${after.reason}`
              : after.state
      })
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      for (const listener of [...this.stateListeners]) listener(after)
    }
    return next.actions
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
