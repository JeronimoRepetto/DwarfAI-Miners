// The generic ACP client every ACP driver reuses (15 §4.10, frozen): the ACP TS SDK's
// `ClientSideConnection` over `ndJsonStream` on the agent's stdio. The agent process is spawned
// through the kernel `ProcessControl` (argv array; `shell: false` is fixed in the adapter) with the
// environment the driver built from `childEnv` (15 §4). `initialize` declares only the client
// capability that is implemented: `elicitation.form` (the question card); never `fs`, never
// `terminal`. Then `session/new {cwd, mcpServers}` (a launch) or `session/load` / `session/resume`
// (a resume, per the agent's `initialize` capabilities). Turns are `session/prompt`, whose
// `stopReason` maps per ADR-021 item 5; `session/update` becomes message / activity events with
// `eventId = <turnId>:<seq>` for aggregated chunks (ADR-006 item 2); `session/cancel` interrupts;
// `session/close` ends the thread. Asks are `session/request_permission` and form
// `elicitation/create` (15 §2.7); an unknown server request is answered with a protocol error by
// the SDK and opens nothing (fail closed). The driver never signals a process (ADR-014).
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AnyMessage,
  type Client,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type McpServer,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification
} from '@agentclientprotocol/sdk'
import type { ProcessIdentity } from '../../../../../../kernel/domain/processIdentity'
import type {
  AnswerOutcome,
  QuestionAnswers,
  TurnEndKind,
  UsageObservation
} from '../../../../../../kernel/domain/sharedContracts'
import type { Clock } from '../../../../../../kernel/ports/clock'
import type { ProcessControl, SpawnedProcess } from '../../../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../../../kernel/ports/scheduler'
import type { ProviderCapabilities } from '../../../../domain/capabilities'
import type {
  CloseOutcome,
  DriverEvent,
  DriverSendError,
  DriverSession,
  SendReceipt,
  SessionRef,
  TurnInput
} from '../../../../ports/providerDriver'
import { turnEndOf } from '../stopReason'
import { answerReply, CANCEL, DECLINE, formOf, type ElicitationForm } from './elicitation'
import { EventChannel } from './eventChannel'
import {
  optionSet,
  permissionPayload,
  permissionReply,
  type AcpPermissionOption
} from './permissionMapping'

/** 15 §0: the readiness bound of a launch or a resume. */
export const HANDSHAKE_TIMEOUT_MS = 30_000
/** ADR-020 D4: an exit before readiness inside this window is `exited-at-once`. */
export const EARLY_FAILURE_WINDOW_MS = 3_000
/** ADR-014 item 1: the budget of a protocol close. */
export const CLOSE_BUDGET_MS = 2_000
/** ADR-020 D1, D6: the output tail a launch failure carries, at most. */
const TAIL_CHARS = 400
/** The ACP `auth_required` error code (`session-setup.mdx`): the agent is not logged in. */
const AUTH_REQUIRED = -32000

/** The `session/update` kinds of the pinned protocol (`SessionUpdate`); any other is drift. */
const KNOWN_UPDATES = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'notice',
  'compaction_update',
  'compaction_summary_chunk',
  'subagent_update',
  'session_message',
  'session_message_chunk'
])

export interface AcpClientDeps {
  readonly processControl: ProcessControl
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** One-line redaction of activity summaries and card lines (bound by wiring). */
  readonly redact: (text: string) => string
}

/** Why a handshake failed, for the driver to map onto its launch or resume error. */
export interface HandshakeFailure {
  /** The process ended before readiness inside the early-failure window. */
  readonly early: boolean
  readonly detail: string
  /** The last characters the agent wrote on stderr (≤ 400). */
  readonly tail: string
  /** The JSON-RPC error code the agent refused a handshake request with, if it did. */
  readonly code?: number
  /** The process could not be spawned at all (its spawn error code). */
  readonly spawnCode?: string
  /** The session could not be put in the pinned permission mode (AMENDMENT-19): never early. */
  readonly modePin?: true
}

export interface AcpStart {
  readonly providerId: SessionRef['providerId']
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly mcpServers: readonly McpServer[]
  /**
   * AMENDMENT-19: the `_meta` sent with `session/new` and `session/load` (the driver's documented
   * adapter options, such as one that refuses skip-permission modes).
   */
  readonly sessionMeta?: Readonly<Record<string, unknown>>
  /**
   * AMENDMENT-19: the permission mode the session must report before it is ready. A session in
   * another mode is sent `session/set_mode`; one that reports no mode, refuses it or keeps another
   * mode fails the handshake closed. Absent: no pin.
   */
  readonly pinnedMode?: string
  /**
   * ADR-008 item 3: whether a reported session mode skips the permission ask. With no pinned mode,
   * a session that reports such a mode fails the handshake closed. Absent: no mode is refused.
   */
  readonly refusedMode?: (modeId: string) => boolean
  /** A launch opens a new session and sends its first prompt; a resume reopens `sessionId`. */
  readonly mode:
    | { readonly kind: 'new'; readonly prompt: string }
    | {
        readonly kind: 'resume'
        readonly sessionId: string
        /**
         * The turns the resumed session already had. `session/resume` replays nothing, so its next
         * turn continues this count (`eventId = <turnId>:<seq>` never meets an earlier turn's);
         * `session/load` rebuilds the count from its replay. Absent: 0.
         */
        readonly turnsBefore?: number
      }
  /** The effective capabilities once `initialize` answered (the driver merges its sources). */
  readonly capabilitiesFor: (init: InitializeResponse) => ProviderCapabilities
  readonly onSpawned?: (identity: ProcessIdentity) => Promise<void>
  /** Called once when the session's events ended (after `exited`). */
  readonly onExit: (ref: SessionRef) => void
}

/**
 * Spawns the agent and runs the handshake. Resolves with a ready session; rejects with a
 * `HandshakeFailure` (the driver maps it onto `DriverLaunchError` / `DriverResumeError`).
 */
export function startAcpSession(deps: AcpClientDeps, start: AcpStart): Promise<AcpSession> {
  return new AcpSession(deps, start).ready
}

type PendingAsk =
  | {
      readonly kind: 'permission'
      readonly options: readonly AcpPermissionOption[]
      readonly reply: (response: RequestPermissionResponse) => void
      readonly refuse: (error: RequestError) => void
    }
  | {
      readonly kind: 'question'
      readonly form: ElicitationForm
      readonly reply: (response: CreateElicitationResponse) => void
    }

interface OpenTurn {
  readonly n: number
  readonly key: string
  interrupted: boolean
  readonly ended: Promise<void>
  readonly markEnded: () => void
}

interface Segment {
  readonly role: 'person' | 'dwarf'
  readonly eventId: string
  text: string
}

interface Tool {
  readonly toolName: string
  summary: string
  done: boolean
}

type Tokens = UsageObservation['tokens']

export class AcpSession implements DriverSession {
  ref: SessionRef
  capabilities: ProviderCapabilities
  readonly ready: Promise<AcpSession>
  private readonly channel = new EventChannel<DriverEvent>()
  private readonly child: SpawnedProcess
  private readonly spawnedAt: number
  private connection: ClientSideConnection | null = null
  private init: InitializeResponse | null = null
  private settleReady: ((failure: Omit<HandshakeFailure, 'early' | 'tail'> | null) => void) | null
  /** The session's permission mode as the agent last reported it (AMENDMENT-19). */
  private currentMode: string | null = null
  private handshakeTimer: { cancel(): void } | null = null
  private stderrTail = ''
  private turn: OpenTurn | null = null
  private readonly queue: { text: string; echoOf: string }[] = []
  private turnCount = 0
  private seq = 0
  private segment: Segment | null = null
  private replaying = false
  private readonly tools = new Map<string, Tool>()
  private readonly asks = new Map<string, PendingAsk>()
  private asked = 0
  private readonly continuations: ((arrived: boolean) => void)[] = []
  private readonly reported = new Set<string>()
  private closing = false
  private closed = false
  private outputEnded = false
  private exitSeen = false
  private exitCode: number | null = null
  private exited = false

  constructor(
    private readonly deps: AcpClientDeps,
    private readonly start: AcpStart
  ) {
    this.ref = {
      providerId: start.providerId,
      providerSessionId: start.mode.kind === 'resume' ? start.mode.sessionId : ''
    }
    this.capabilities = start.capabilitiesFor({ protocolVersion: PROTOCOL_VERSION })
    this.spawnedAt = deps.clock.now()
    this.child = deps.processControl.spawn({
      executable: start.executable,
      args: start.args,
      cwd: start.cwd,
      env: { ...start.env },
      processGroup: 'own',
      stdio: 'pipe'
    })
    this.child.exited.catch(() => undefined)
    let settle: (failure: Omit<HandshakeFailure, 'early' | 'tail'> | null) => void = () => {}
    this.ready = new Promise<AcpSession>((resolve, reject) => {
      settle = (failure) => {
        this.settleReady = null
        this.handshakeTimer?.cancel()
        if (failure === null) {
          resolve(this)
          return
        }
        const early =
          failure.spawnCode === undefined &&
          failure.modePin !== true &&
          failure.detail !== 'handshake timeout' &&
          deps.clock.now() - this.spawnedAt < EARLY_FAILURE_WINDOW_MS
        this.closeInput()
        reject({ ...failure, early, tail: this.tail() } satisfies HandshakeFailure)
      }
    })
    this.settleReady = settle
    void this.begin()
  }

  events(): AsyncIterable<DriverEvent> {
    return this.channel
  }

  /** A session serializes as what it is to the Host: its ref and effective capabilities. */
  /** How many turns this session started or replayed so far (a resume continues it). */
  get turns(): number {
    return this.turnCount
  }

  toJSON(): { ref: SessionRef; capabilities: ProviderCapabilities } {
    return { ref: this.ref, capabilities: this.capabilities }
  }

  // ---------- the handshake ----------

  private async begin(): Promise<void> {
    let identity: ProcessIdentity
    try {
      identity = await this.child.identity
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      this.outputEnded = true
      this.exitSeen = true
      this.settleReady?.({
        detail: `spawn ${typeof code === 'string' ? code : 'failed'}`,
        spawnCode: typeof code === 'string' ? code : 'failed'
      })
      return
    }
    this.ref = { ...this.ref, pid: identity.pid, processStartTimeMs: identity.processStartTimeMs }
    await this.start.onSpawned?.(identity)
    this.handshakeTimer = this.deps.scheduler.after(HANDSHAKE_TIMEOUT_MS, () => {
      // 15 §1.3: on a handshake timeout the driver closes its transport and rejects.
      this.settleReady?.({ detail: 'handshake timeout' })
    })
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-TAIL_CHARS * 4)
    })
    this.child.stdout?.on('end', () => this.outputEnd())
    void this.child.exited.then(
      (outcome) => this.processExit(outcome.code),
      () => this.processExit(null)
    )
    if (this.child.stdin === null || this.child.stdout === null) {
      this.settleReady?.({ detail: 'the agent has no stdio' })
      return
    }
    const wire = ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>
    )
    const readable = wire.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        transform: (message, controller) => {
          if (this.inbound(message)) controller.enqueue(message)
        }
      })
    )
    const connection = new ClientSideConnection(() => this.client(), {
      readable,
      writable: wire.writable
    })
    this.connection = connection
    try {
      await this.handshake(connection)
    } catch (error) {
      if (this.settleReady === null) return
      const code = error instanceof RequestError ? error.code : undefined
      this.settleReady({
        detail: code === undefined ? 'the handshake failed' : `the agent refused with ${code}`,
        ...(code === undefined ? {} : { code })
      })
    }
  }

  private async handshake(connection: ClientSideConnection): Promise<void> {
    const init = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } }
    })
    if (this.settleReady === null) return
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      this.settleReady({ detail: `protocol version ${String(init.protocolVersion)}` })
      return
    }
    this.init = init
    this.capabilities = this.start.capabilitiesFor(init)
    const { cwd, mcpServers, mode, sessionMeta } = this.start
    const meta = sessionMeta === undefined ? {} : { _meta: { ...sessionMeta } }
    if (mode.kind === 'new') {
      const opened = await connection.newSession({ cwd, mcpServers: [...mcpServers], ...meta })
      if (this.settleReady === null) return
      this.ref = { ...this.ref, providerSessionId: opened.sessionId }
      if (!(await this.pinMode(connection, opened.modes?.currentModeId))) return
      this.settleReady(null)
      this.startTurn(mode.prompt, null)
      return
    }
    const agent = init.agentCapabilities
    if (agent?.loadSession === true) {
      // `session/load` replays the history as `session/update`s before it answers.
      this.replaying = true
      const loaded = await connection.loadSession({
        sessionId: mode.sessionId,
        cwd,
        mcpServers: [...mcpServers],
        ...meta
      })
      this.flushSegment()
      this.replaying = false
      if (!(await this.pinMode(connection, loaded?.modes?.currentModeId))) return
    } else if (agent?.sessionCapabilities?.resume != null) {
      // `session/resume` replays nothing: the next turn continues the resumed session's count.
      this.turnCount = mode.turnsBefore ?? 0
      const resumed = await connection.resumeSession({
        sessionId: mode.sessionId,
        cwd,
        mcpServers: [...mcpServers],
        ...meta
      })
      if (!(await this.pinMode(connection, resumed?.modes?.currentModeId))) return
    } else {
      this.settleReady?.({ detail: 'the agent offers neither session/load nor session/resume' })
      return
    }
    this.settleReady?.(null)
  }

  /**
   * AMENDMENT-19 (ADR-008 item 3): before the session is ready it must report the pinned mode, so
   * the person's own default mode (one that skips the permission check) never applies. Another
   * mode is changed with `session/set_mode`; the agent answers `{}` and reports a different
   * effective mode with `current_mode_update` before its answer. With no pinned mode, a reported
   * mode the driver refuses (`refusedMode`) fails closed instead. False when the handshake failed.
   */
  private async pinMode(
    connection: ClientSideConnection,
    reported: string | null | undefined
  ): Promise<boolean> {
    const pinned = this.start.pinnedMode
    if (typeof reported === 'string') this.currentMode = reported
    const fail = (detail: string): false => {
      this.settleReady?.({ detail, modePin: true })
      return false
    }
    if (pinned === undefined) {
      const mode = this.currentMode
      return mode !== null && this.start.refusedMode?.(mode) === true
        ? fail(`the agent reports permission mode ${mode}, which skips the permission ask`)
        : true
    }
    if (this.currentMode === null) return fail('the agent reports no permission mode')
    if (this.currentMode === pinned) return true
    const before = this.currentMode
    this.currentMode = pinned
    try {
      await connection.setSessionMode({ sessionId: this.ref.providerSessionId, modeId: pinned })
    } catch (error) {
      const code = error instanceof RequestError ? `with ${error.code}` : 'by the transport'
      return fail(
        `the agent kept permission mode ${before}: set_mode ${pinned} was refused ${code}`
      )
    }
    if (this.settleReady === null) return false
    if (this.currentMode !== pinned) {
      return fail(`the agent kept permission mode ${this.currentMode} after set_mode ${pinned}`)
    }
    return true
  }

  /**
   * The `Client` side the SDK calls; every handler is the session's own. The pinned SDK answers a
   * client method the `Client` leaves out with a success (`fs/write_text_file` → `{}`,
   * `terminal/create` → `null`), so every method DwarfAI does not implement is answered here with
   * `Method not found` instead: no `fs`, no `terminal`, no extension method (15 §4.10; fail closed).
   */
  private client(): Client {
    const notImplemented = (method: string) => (): never => {
      throw RequestError.methodNotFound(method)
    }
    return {
      requestPermission: (params) => this.onPermission(params),
      sessionUpdate: (params) => this.onUpdate(params),
      createElicitation: (params) => this.onElicitation(params),
      readTextFile: notImplemented('fs/read_text_file'),
      writeTextFile: notImplemented('fs/write_text_file'),
      createTerminal: notImplemented('terminal/create'),
      terminalOutput: notImplemented('terminal/output'),
      releaseTerminal: notImplemented('terminal/release'),
      waitForTerminalExit: notImplemented('terminal/wait_for_exit'),
      killTerminal: notImplemented('terminal/kill'),
      extMethod: (method) => notImplemented(method)()
    }
  }

  /**
   * Every message the agent sends, before the SDK handles it. Any message is evidence that the
   * agent took the reply written before it (the answer's hand-over, ADR-010 item 8). An update
   * of a kind the pinned protocol does not have is drift: reported once and dropped (HO-33).
   */
  private inbound(message: AnyMessage): boolean {
    for (const continuation of this.continuations.splice(0)) continuation(true)
    if (!('method' in message) || message.method !== 'session/update' || 'id' in message) {
      return true
    }
    const update = (message.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update
    const kind = update?.sessionUpdate
    if (typeof kind === 'string' && KNOWN_UPDATES.has(kind)) return true
    const detail = `session/update ${typeof kind === 'string' ? kind : 'without a kind'}`
    this.reportOnce(`drift:${detail}`, { kind: 'protocol-drift', detail })
    return false
  }

  // ---------- turns ----------

  async sendTurn(input: TurnInput): Promise<SendReceipt> {
    if (this.exited || this.closing || this.outputEnded) {
      throw sendError('session-closed', 'the session has ended')
    }
    if (input.attachments.length > 0) {
      throw sendError('channel-error', 'this driver does not send attachments yet')
    }
    const held = this.turn !== null
    const n = this.turnCount + this.queue.length + 1
    if (held) this.queue.push({ text: input.text, echoOf: input.messageId })
    else this.startTurn(input.text, input.messageId)
    // A prompt is acknowledged only by its stopReason, at the turn's end: written, not confirmed.
    return {
      confidence: 'unconfirmed',
      heldUntilTurnEnd: held,
      correlation: input.messageId,
      providerTurnId: String(n)
    }
  }

  private startTurn(text: string, echoOf: string | null): void {
    const connection = this.connection
    if (connection === null) return
    this.turnCount += 1
    this.seq = 0
    const n = this.turnCount
    let markEnded: () => void = () => {}
    const ended = new Promise<void>((resolve) => {
      markEnded = resolve
    })
    const turn: OpenTurn = { n, key: this.key(`turn:${n}`), interrupted: false, ended, markEnded }
    this.turn = turn
    this.emit({ t: 'status', value: 'working' })
    this.emit({
      t: 'message',
      record: {
        sourceKey: this.key(`${n}:0`),
        role: 'person',
        text,
        providerTime: null,
        ...(echoOf === null ? {} : { echoOf })
      }
    })
    connection
      .prompt({ sessionId: this.ref.providerSessionId, prompt: [{ type: 'text', text }] })
      .then(
        (response) => this.endTurn(turn, response),
        (error: unknown) => this.turnRefused(turn, error)
      )
  }

  private endTurn(turn: OpenTurn, response: PromptResponse): void {
    if (this.exited || this.outputEnded) return
    const end = turnEndOf(response.stopReason)
    this.finishTurn(turn, end.kind, end.detail, response.usage ?? null)
  }

  private turnRefused(turn: OpenTurn, error: unknown): void {
    // The transport went away: its end is the exit path's (C-18), not a turn end.
    if (this.exited || this.outputEnded || !(error instanceof RequestError)) return
    if (error.code === AUTH_REQUIRED) this.reportOnce('auth-required', { kind: 'auth-required' })
    this.finishTurn(turn, 'errored', `session/prompt error ${error.code}`, null)
  }

  private finishTurn(
    turn: OpenTurn,
    kind: TurnEndKind,
    detail: string | undefined,
    usage: PromptResponse['usage']
  ): void {
    if (this.turn !== turn) return
    this.flushSegment()
    this.reportUsage(turn, usage)
    this.emit({
      t: 'turn.ended',
      end: {
        turnKey: turn.key,
        kind,
        at: this.deps.clock.now(),
        reliability: 'reliable',
        cancelledFromApp: kind === 'interrupted' && turn.interrupted,
        ...(detail === undefined ? {} : { detail })
      }
    })
    this.turn = null
    turn.markEnded()
    const next = this.queue.shift()
    if (next === undefined) this.emit({ t: 'status', value: 'idle' })
    else this.startTurn(next.text, next.echoOf)
  }

  /**
   * ADR-006 items 4 and 6: one sealed observation per turn, the `usage` of that turn's
   * `session/prompt` response. The pinned schema calls it "token usage for this turn" while its
   * `Usage` fields say "across all turns"; the recordings of claude-agent-acp 0.93.0
   * (`fixtures/claude/acp/2.1.x/`) show the turn's own counts (a second turn reports fewer output
   * tokens than the first), so each report is counted as it is, a resumed session's first one too.
   */
  private reportUsage(turn: OpenTurn, usage: PromptResponse['usage']): void {
    if (usage === null || usage === undefined) return
    const tokens: Tokens = {
      inputNet: count(usage.inputTokens),
      output: count(usage.outputTokens),
      cacheRead: count(usage.cachedReadTokens),
      cacheWrite: count(usage.cachedWriteTokens),
      reasoning: count(usage.thoughtTokens)
    }
    this.emit({
      t: 'usage',
      observation: {
        sourceKey: turn.key,
        unitKey: `${this.ref.providerSessionId}:turn:${turn.n}`,
        fidelity: this.capabilities.usage.fidelity,
        tokens,
        sealed: true,
        providerTime: null
      }
    })
  }

  async interrupt(): Promise<void> {
    const turn = this.turn
    const connection = this.connection
    if (turn === null || connection === null || this.exited) return
    turn.interrupted = true
    await connection.cancel({ sessionId: this.ref.providerSessionId }).catch(() => undefined)
    // HR A7: the client answers every request of the cancelled turn `cancelled`.
    for (const [id, ask] of [...this.asks]) {
      this.asks.delete(id)
      if (ask.kind === 'permission') ask.reply({ outcome: { outcome: 'cancelled' } })
      else ask.reply(CANCEL)
      this.emit({ t: 'ask.resolved', providerRequestId: id, by: 'cancelled' })
    }
    await turn.ended
  }

  // ---------- updates ----------

  private onUpdate(notification: SessionNotification): void {
    if (notification.sessionId !== this.ref.providerSessionId) return
    const update = notification.update
    switch (update.sessionUpdate) {
      case 'current_mode_update':
        this.currentMode = update.currentModeId
        return
      case 'agent_message_chunk':
        if (update.content.type === 'text') this.append('dwarf', update.content.text)
        return
      case 'user_message_chunk':
        // A live turn's prompt is already its person message; a replay rebuilds it (C-16).
        if (this.replaying && update.content.type === 'text')
          this.append('person', update.content.text)
        return
      case 'tool_call': {
        this.flushSegment()
        if (this.replaying) return
        const tool: Tool = {
          toolName: nonEmpty(update.name) ?? update.kind ?? 'tool',
          summary: this.summary(update.title),
          done: false
        }
        this.tools.set(update.toolCallId, tool)
        this.emitTool(update.toolCallId, tool, 'started')
        if (update.status === 'completed' || update.status === 'failed') {
          this.finishTool(update.toolCallId, update.status)
        }
        return
      }
      case 'tool_call_update': {
        if (this.replaying) return
        const tool = this.tools.get(update.toolCallId)
        if (tool === undefined) return
        if (nonEmpty(update.title) !== null) tool.summary = this.summary(update.title)
        if (update.status === 'completed' || update.status === 'failed') {
          this.finishTool(update.toolCallId, update.status)
        }
        return
      }
      default:
        return
    }
  }

  /** Aggregates chunks into one entry per message (`eventId = <turnId>:<seq>`, ADR-006 item 2). */
  private append(role: Segment['role'], text: string): void {
    if (this.segment?.role === role) {
      this.segment.text += text
      return
    }
    this.flushSegment()
    if (role === 'person') {
      // A replayed person message opens the replayed turn, as its prompt opened the live one.
      this.turnCount += 1
      this.seq = 0
      this.segment = { role, eventId: `${this.turnCount}:0`, text }
      return
    }
    this.seq += 1
    this.segment = { role, eventId: `${this.turnCount}:${this.seq}`, text }
  }

  private flushSegment(): void {
    const segment = this.segment
    this.segment = null
    if (segment === null || segment.text === '') return
    this.emit({
      t: 'message',
      record: {
        sourceKey: this.key(segment.eventId),
        role: segment.role,
        text: segment.text,
        providerTime: null
      }
    })
  }

  private finishTool(id: string, status: 'completed' | 'failed'): void {
    const tool = this.tools.get(id)
    if (tool === undefined || tool.done) return
    tool.done = true
    this.emitTool(id, tool, status === 'completed' ? 'finished' : 'failed')
  }

  private emitTool(id: string, tool: Tool, state: 'started' | 'finished' | 'failed'): void {
    this.emit({
      t: 'activity',
      step: {
        sourceKey: this.key(id),
        turnKey: this.turn?.key ?? null,
        kind: 'tool',
        toolName: tool.toolName,
        summary: tool.summary,
        state,
        at: null
      }
    })
  }

  private summary(title: string | null | undefined): string {
    const line = (nonEmpty(title) ?? '').split(/\r?\n/)[0] ?? ''
    return this.deps.redact(line.slice(0, 240))
  }

  // ---------- asks ----------

  private onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (params.sessionId !== this.ref.providerSessionId) {
      return Promise.reject(RequestError.invalidParams(undefined, 'unknown session'))
    }
    this.flushSegment()
    const id = this.askId(params.toolCall.toolCallId)
    const options = params.options.map((option) => ({
      optionId: option.optionId,
      kind: option.kind
    }))
    return new Promise((resolve, reject) => {
      this.asks.set(id, { kind: 'permission', options, reply: resolve, refuse: reject })
      this.emit({
        t: 'ask.opened',
        ask: {
          kind: 'permission',
          providerRequestId: id,
          channel: 'driver',
          payload: permissionPayload(params.toolCall, this.deps.redact),
          options: optionSet(options),
          ...(this.turn === null ? {} : { turnKey: this.turn.key })
        }
      })
    })
  }

  private onElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const scope = params as { sessionId?: unknown; toolCallId?: unknown }
    const form = formOf(params as Parameters<typeof formOf>[0])
    if (scope.sessionId !== this.ref.providerSessionId || form === null) {
      // Only a form question of this session is a card; anything else is refused (fail closed).
      return Promise.reject(RequestError.invalidParams(undefined, 'not a question form'))
    }
    this.flushSegment()
    const id = this.askId(
      typeof scope.toolCallId === 'string' ? `question:${scope.toolCallId}` : null
    )
    return new Promise((resolve) => {
      this.asks.set(id, { kind: 'question', form, reply: resolve })
      this.emit({
        t: 'ask.opened',
        ask: {
          kind: 'question',
          providerRequestId: id,
          channel: 'driver',
          payload: form.payload,
          secret: false,
          ...(this.turn === null ? {} : { turnKey: this.turn.key })
        }
      })
    })
  }

  /** A request id unique in this session: the tool call's id, else the request's ordinal. */
  private askId(preferred: string | null): string {
    this.asked += 1
    const base = preferred ?? `request-${this.asked}`
    return this.asks.has(base) ? `${base}:${this.asked}` : base
  }

  async answerPermission(req: {
    providerRequestId: string
    decision: 'allow' | 'deny'
  }): Promise<AnswerOutcome> {
    const ask = this.asks.get(req.providerRequestId)
    if (ask === undefined || ask.kind !== 'permission') {
      return { kind: 'refused', reason: 'ask-closed' }
    }
    if (this.outputEnded || this.exited) return { kind: 'refused', reason: 'channel-unavailable' }
    const reply = permissionReply(ask.options, req.decision)
    // An Allow the options cannot carry without widening it is never sent (OQ-42 B).
    if (reply.kind === 'refuse') return { kind: 'refused', reason: 'channel-rejected' }
    this.asks.delete(req.providerRequestId)
    const handedOver = this.continuation()
    if (reply.kind === 'select') {
      ask.reply({ outcome: { outcome: 'selected', optionId: reply.optionId } })
    } else {
      // No reject_once: the request is refused with a JSON-RPC error (fail closed, HR A3).
      ask.refuse(RequestError.internalError(undefined, 'denied: no reject_once option'))
    }
    return handedOver
  }

  async answerQuestion(
    req:
      | { providerRequestId: string; answers: QuestionAnswers }
      | { providerRequestId: string; decline: true }
  ): Promise<AnswerOutcome> {
    const ask = this.asks.get(req.providerRequestId)
    if (ask === undefined || ask.kind !== 'question') {
      return { kind: 'refused', reason: 'ask-closed' }
    }
    if (this.outputEnded || this.exited) return { kind: 'refused', reason: 'channel-unavailable' }
    const reply = 'decline' in req ? DECLINE : answerReply(ask.form, req.answers)
    if (reply === 'invalid-answer') return { kind: 'refused', reason: 'invalid-answer' }
    this.asks.delete(req.providerRequestId)
    const handedOver = this.continuation()
    ask.reply(reply)
    return handedOver
  }

  /** `accepted` once the agent sends anything after the reply; `channel-unavailable` if it ends. */
  private continuation(): Promise<AnswerOutcome> {
    return new Promise((resolve) => {
      this.continuations.push((arrived) =>
        resolve(arrived ? { kind: 'accepted' } : { kind: 'refused', reason: 'channel-unavailable' })
      )
    })
  }

  // ---------- close and the end ----------

  async close(mode: 'detach' | 'end-thread'): Promise<CloseOutcome> {
    if (mode === 'detach') return { kind: 'failed', reason: 'unsupported' }
    if (this.closed) return { kind: 'closed' }
    this.closed = true
    let outcome: CloseOutcome = { kind: 'closed' }
    const connection = this.connection
    const closable = this.init?.agentCapabilities?.sessionCapabilities?.close != null
    if (connection !== null && closable && !this.outputEnded && !this.exited) {
      let timer: { cancel(): void } | undefined
      const late = new Promise<CloseOutcome>((resolve) => {
        timer = this.deps.scheduler.after(CLOSE_BUDGET_MS, () =>
          resolve({ kind: 'failed', reason: 'timeout' })
        )
      })
      const asked = connection.closeSession({ sessionId: this.ref.providerSessionId }).then(
        (): CloseOutcome => ({ kind: 'closed' }),
        (): CloseOutcome => ({ kind: 'failed', reason: 'protocol-error' })
      )
      outcome = await Promise.race([asked, late])
      timer?.cancel()
    }
    this.closeInput()
    return outcome
  }

  private closeInput(): void {
    if (this.closing) return
    this.closing = true
    this.child.stdin?.end()
  }

  /** stdout ended: before an asked-for end, the transport is lost (15 §1.3 `events()`, C-18). */
  private outputEnd(): void {
    this.outputEnded = true
    for (const continuation of this.continuations.splice(0)) continuation(false)
    if (this.settleReady === null && !this.closing && !this.exited) {
      this.emit({ t: 'error', cause: { kind: 'transport-lost', detail: 'the agent output ended' } })
    }
    this.maybeExit()
  }

  private processExit(code: number | null): void {
    if (this.settleReady !== null) {
      this.settleReady({ detail: 'exited before readiness' })
      this.outputEnded = true
    }
    this.exitSeen = true
    this.exitCode = code
    this.maybeExit()
  }

  /** `exited` is last and once, after both the output's end and the process exit (15 §1.4). */
  private maybeExit(): void {
    if (!this.outputEnded || !this.exitSeen || this.exited) return
    this.exited = true
    this.asks.clear()
    this.tools.clear()
    this.channel.push({ t: 'exited', code: this.exitCode })
    this.channel.close()
    this.start.onExit(this.ref)
  }

  // ---------- helpers ----------

  /** 15 §1.5: `sourceKey = <adapterId>:<providerId>:<sessionId>:<eventId>`, adapterId the family. */
  private key(eventId: string): string {
    const { providerId, providerSessionId } = this.ref
    return `${providerId}:${providerId}:${providerSessionId}:${eventId}`
  }

  /** HO-33: each distinct error is reported once per session. */
  private reportOnce(key: string, cause: Extract<DriverEvent, { t: 'error' }>['cause']): void {
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.emit({ t: 'error', cause })
  }

  private emit(event: DriverEvent): void {
    if (!this.exited) this.channel.push(event)
  }

  private tail(): string {
    return this.stderrTail.slice(-TAIL_CHARS)
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function sendError(kind: DriverSendError['kind'], reason: string): DriverSendError {
  return { kind, reason }
}
