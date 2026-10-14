// A small JSONL test driver for the harness's own tests (17 §2.2 double): it spawns through the
// kernel ProcessControl, as every owned driver does (15 §4, AMENDMENT-10), and speaks a toy line
// protocol over the fixture transport, so the cases a transport-less SimulatedDriver cannot reach
// (spawn, environment, argv, EOF, asks, hand-over, protocol negotiation) have a conformant driver
// to pass them and purpose-built faults to fail them. Not a provider: no catalog record names it.
//
// Provider → driver lines: `ready {session, capabilities?}`, `message {id, text}`,
// `permission {request, options, tool, text}`, `ack {request}`, `error {request}`,
// `turn_end {turn, reason}`. Driver → provider: `prompt {id, text}`, `reply {request, option}`,
// `cancel {}`, `bye {}`.
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { AnswerOutcome, TurnEndKind } from '../../../kernel/domain/sharedContracts'
import type { SpawnedProcess } from '../../../kernel/ports/processControl'
import type { ProviderCapabilities } from '../domain/capabilities'
import { combineLowest, merge, type NegotiatedCapabilities } from '../domain/mergeCapabilities'
import type { ProviderProfile } from '../domain/profile'
import type {
  DetectResult,
  DriverEvent,
  DriverLaunchError,
  DriverLaunchRequest,
  DriverSession,
  ProviderDriver,
  SendReceipt,
  SessionRef,
  TurnInput
} from '../ports/providerDriver'
import type { ConformanceRig } from './driverConformance'

export const LINE_HANDSHAKE_TIMEOUT_MS = 30_000
export const LINE_EARLY_FAILURE_MS = 3_000
export const LINE_HANDOVER_MS = 30_000
const TAIL_CHARS = 400

/** The named login-environment variables a child may receive (15 §4 `childEnv`, abridged). */
const CHILD_ENV_ALLOWLIST = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'LANG']

export const LINE_PROFILE: ProviderProfile = {
  id: 'line-test',
  label: 'Line test',
  binaries: ['line-test'],
  models: [],
  efforts: [],
  permissionModes: [],
  drivers: ['ndjson'],
  publicLaunch: 'enabled'
}

export const LINE_CEILING: ProviderCapabilities = {
  launch: true,
  observe: false,
  sendTurn: true,
  interrupt: true,
  permission: 'interactive',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'none',
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'none',
  subagents: 'none',
  usage: { fidelity: 0, rateLimits: false },
  mcpInjection: 'none',
  console: 'log',
  earlyFailure: 'handshake',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
}

/** Each fault breaks exactly one contract rule (the case named beside it). */
export interface LineDriverFaults {
  /** C-02: spawns its own bundled copy instead of the person's install. */
  readonly bundledPath?: true
  /** C-03: reports a spawn EACCES as not-installed. */
  readonly eaccesAsNotInstalled?: true
  /** C-03: keeps the whole stderr as the output tail. */
  readonly unboundedTail?: true
  /** C-04: reports every exit before readiness as could-not-start, even inside the 3 s window. */
  readonly noEarlyWindow?: true
  /** C-08: does not resolve the open asks when it interrupts. */
  readonly keepsAsksOnInterrupt?: true
  /** C-14: maps the provider's protocol error reply to accepted. */
  readonly errorReplyAccepted?: true
  /** C-15: answers accepted without waiting for the provider's acknowledgement. */
  readonly acceptsWithoutAck?: true
  /** C-18: on EOF reports exited without the transport-lost error. */
  readonly silentEof?: true
  /** C-23: hands the child the whole login environment. */
  readonly leaksLoginEnv?: true
  /** C-24: passes an auto-approve flag. */
  readonly autoApproveFlag?: true
  /** C-25b: takes the probe's values over the protocol's (an object spread). */
  readonly probeOverProtocol?: true
}

export interface LineDriverOptions {
  readonly rig: ConformanceRig
  /** What `probe()` answers (the runtime check source of 15 §2.1). */
  readonly probe: NegotiatedCapabilities
  readonly faults?: LineDriverFaults
}

export class LineTestDriver implements ProviderDriver {
  readonly profile = LINE_PROFILE
  readonly transport = 'ndjson' as const

  constructor(private readonly options: LineDriverOptions) {}

  async detect(): Promise<DetectResult> {
    return { kind: 'not-installed' }
  }

  async probe(): Promise<ProviderCapabilities> {
    return merge(LINE_CEILING, this.options.probe)
  }

  async launch(req: DriverLaunchRequest): Promise<DriverSession> {
    const { rig, faults = {} } = this.options
    const env: Record<string, string> = {}
    for (const name of CHILD_ENV_ALLOWLIST) {
      const value = rig.loginEnv[name]
      if (value !== undefined) env[name] = value
    }
    if (faults.leaksLoginEnv) Object.assign(env, rig.loginEnv)
    env.DWARFAI_SPAWN = req.spawnTag
    const spawnedAt = rig.clock.now()
    const child = rig.processControl.spawn({
      executable: faults.bundledPath ? '/opt/dwarfai/bundled/line-test' : req.install.binaryPath,
      args: faults.autoApproveFlag ? ['--jsonl', '--yolo'] : ['--jsonl'],
      cwd: req.cwd,
      env,
      processGroup: 'own',
      stdio: 'pipe'
    })
    let identity: ProcessIdentity
    try {
      identity = await child.identity
    } catch (error) {
      const code = (error as { code?: string }).code
      const notInstalled = code === 'ENOENT' || (code === 'EACCES' && faults.eaccesAsNotInstalled)
      const failure: DriverLaunchError = notInstalled
        ? { cause: 'not-installed', detail: `spawn ${code}` }
        : { cause: 'could-not-start', detail: `spawn ${code ?? 'failed'}` }
      throw failure
    }
    await req.onSpawned(identity)
    const session = new LineSession(child, this.options, spawnedAt)
    return session.handshake()
  }
}

type Waiter = (line: Record<string, unknown>) => void

class LineSession implements DriverSession {
  ref: SessionRef = { providerId: LINE_PROFILE.id, providerSessionId: '' }
  capabilities: ProviderCapabilities = LINE_CEILING
  private readonly channel = new EventChannel<DriverEvent>()
  private readonly asks = new Map<string, Waiter | null>()
  private stderrTail = ''
  private buffer = ''
  private openTurn: string | null = null
  private cancelled = false
  private turns = 0
  private exited = false
  private closing = false
  private outputEnded = false
  private exitSeen = false
  private exitCode: number | null = null
  private ready: Waiter | null = null

  constructor(
    private readonly child: SpawnedProcess,
    private readonly options: LineDriverOptions,
    private readonly spawnedAt: number
  ) {}

  handshake(): Promise<DriverSession> {
    const { clock, scheduler } = this.options.rig
    return new Promise((resolve, reject) => {
      const timer = scheduler.after(LINE_HANDSHAKE_TIMEOUT_MS, () => {
        this.ready = null
        reject(this.failure('could-not-start', 'handshake timeout'))
      })
      this.ready = (line) => {
        timer.cancel()
        this.ready = null
        this.ref = { providerId: LINE_PROFILE.id, providerSessionId: String(line.session) }
        this.capabilities = this.negotiate(line.capabilities as NegotiatedCapabilities | undefined)
        resolve(this)
      }
      this.child.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail += chunk.toString()
      })
      this.child.stdout?.on('data', (chunk: Buffer) => this.read(chunk.toString()))
      this.child.stdout?.on('end', () => this.lost())
      void this.child.exited.then((outcome) => {
        if (this.ready !== null) {
          timer.cancel()
          this.ready = null
          const early =
            !this.options.faults?.noEarlyWindow &&
            clock.now() - this.spawnedAt < LINE_EARLY_FAILURE_MS
          reject(this.failure(early ? 'exited-at-once' : 'could-not-start', 'exited before ready'))
          return
        }
        this.exitCode = outcome.code
        this.exitSeen = true
        this.maybeExit()
      })
    })
  }

  /** 15 §2.1: the protocol and probe sources combined field by field, then merged with the ceiling. */
  private negotiate(protocol: NegotiatedCapabilities | undefined): ProviderCapabilities {
    const probe = this.options.probe
    if (this.options.faults?.probeOverProtocol) {
      return merge(LINE_CEILING, { ...protocol, ...probe })
    }
    return merge(LINE_CEILING, combineLowest(protocol ?? {}, probe))
  }

  private failure(cause: DriverLaunchError['cause'], detail: string): DriverLaunchError {
    const tail = this.options.faults?.unboundedTail
      ? this.stderrTail
      : this.stderrTail.slice(-TAIL_CHARS)
    return { cause, detail, ...(tail === '' ? {} : { toolOutputTail: tail }) }
  }

  events(): AsyncIterable<DriverEvent> {
    return this.channel
  }

  async sendTurn(input: TurnInput): Promise<SendReceipt> {
    if (this.exited) throw { kind: 'session-closed', reason: 'the session exited' }
    this.turns += 1
    this.openTurn = `turn-${this.turns}`
    this.cancelled = false
    const correlation = `${this.ref.providerSessionId}:${input.messageId}`
    this.emit({ t: 'status', value: 'working' })
    this.emit({
      t: 'message',
      record: {
        sourceKey: this.key(`echo-${input.messageId}`),
        role: 'person',
        text: input.text,
        providerTime: null,
        echoOf: correlation
      }
    })
    this.write({ type: 'prompt', id: input.messageId, text: input.text })
    return { confidence: 'unconfirmed', heldUntilTurnEnd: false, correlation }
  }

  async interrupt(): Promise<void> {
    if (this.openTurn === null) return
    this.cancelled = true
    this.write({ type: 'cancel' })
    if (this.options.faults?.keepsAsksOnInterrupt) return
    for (const [request, waiter] of this.asks) {
      this.asks.delete(request)
      waiter?.({ type: 'cancelled' })
      this.emit({ t: 'ask.resolved', providerRequestId: request, by: 'cancelled' })
    }
  }

  answerPermission(req: {
    providerRequestId: string
    decision: 'allow' | 'deny'
  }): Promise<AnswerOutcome> {
    const { faults = {}, rig } = this.options
    if (!this.asks.has(req.providerRequestId) || this.asks.get(req.providerRequestId) !== null) {
      return Promise.resolve({ kind: 'refused', reason: 'ask-closed' })
    }
    const option = req.decision === 'allow' ? 'allow_once' : 'reject_once'
    const reply = { type: 'reply', request: req.providerRequestId, option }
    if (faults.acceptsWithoutAck) {
      this.asks.delete(req.providerRequestId)
      this.write(reply)
      return Promise.resolve({ kind: 'accepted' })
    }
    // The waiter is in place before the reply is written: the provider's answer may arrive
    // during the write itself.
    const outcome = new Promise<AnswerOutcome>((resolve) => {
      const timer = rig.scheduler.after(LINE_HANDOVER_MS, () => {
        this.asks.delete(req.providerRequestId)
        resolve({ kind: 'refused', reason: 'channel-unavailable' })
      })
      this.asks.set(req.providerRequestId, (line) => {
        timer.cancel()
        this.asks.delete(req.providerRequestId)
        if (line.type === 'ack' || (line.type === 'error' && faults.errorReplyAccepted)) {
          resolve({ kind: 'accepted' })
        } else if (line.type === 'error') {
          resolve({ kind: 'refused', reason: 'channel-rejected' })
        } else resolve({ kind: 'refused', reason: 'ask-closed' })
      })
    })
    this.write(reply)
    return outcome
  }

  async answerQuestion(): Promise<AnswerOutcome> {
    return { kind: 'refused', reason: 'ask-closed' }
  }

  async close(
    mode: 'detach' | 'end-thread'
  ): Promise<{ kind: 'closed' } | { kind: 'failed'; reason: 'unsupported' }> {
    if (mode === 'detach') return { kind: 'failed', reason: 'unsupported' }
    if (!this.exited && !this.closing) this.write({ type: 'bye' })
    this.closing = true
    return { kind: 'closed' }
  }

  private read(text: string): void {
    this.buffer += text
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const raw = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (raw !== '') this.handle(JSON.parse(raw) as Record<string, unknown>)
      newline = this.buffer.indexOf('\n')
    }
  }

  private handle(line: Record<string, unknown>): void {
    switch (line.type) {
      case 'ready':
        this.ready?.(line)
        return
      case 'message':
        this.emit({
          t: 'message',
          record: {
            sourceKey: this.key(String(line.id)),
            role: 'dwarf',
            text: String(line.text),
            providerTime: null
          }
        })
        return
      case 'permission': {
        const request = String(line.request)
        const options = (line.options as string[] | undefined) ?? []
        this.asks.set(request, null)
        this.emit({
          t: 'ask.opened',
          ask: {
            kind: 'permission',
            providerRequestId: request,
            channel: 'driver',
            payload: { toolName: String(line.tool), requestText: String(line.text) },
            options: {
              hasAllowOnce: options.includes('allow_once'),
              hasRejectOnce: options.includes('reject_once')
            },
            ...(this.openTurn === null ? {} : { turnKey: this.openTurn })
          }
        })
        return
      }
      case 'ack':
      case 'error': {
        const waiter = this.asks.get(String(line.request))
        waiter?.(line)
        return
      }
      case 'turn_end':
        this.endTurn(String(line.turn), String(line.reason))
        return
    }
  }

  private endTurn(turnKey: string, reason: string): void {
    const kinds: Record<string, TurnEndKind> = {
      done: 'concluded',
      cancelled: 'interrupted',
      limit: 'capped'
    }
    const kind = kinds[reason] ?? 'errored'
    this.openTurn = null
    this.emit({
      t: 'turn.ended',
      end: {
        turnKey,
        kind,
        at: this.options.rig.clock.now(),
        reliability: 'reliable',
        cancelledFromApp: kind === 'interrupted' && this.cancelled,
        ...(kind === 'errored' ? { detail: reason } : {})
      }
    })
    this.emit({ t: 'status', value: 'idle' })
  }

  /** CH-04: the output ended while the session was not closing: the transport is lost. */
  private lost(): void {
    if (this.exited || this.ready !== null) return
    this.outputEnded = true
    if (!this.closing && !this.options.faults?.silentEof) {
      this.emit({ t: 'error', cause: { kind: 'transport-lost', detail: 'provider output ended' } })
    }
    this.maybeExit()
  }

  /** `exited` comes once both the output's end and the process exit were observed. */
  private maybeExit(): void {
    if (this.outputEnded && this.exitSeen) this.exit(this.exitCode)
  }

  private exit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    for (const waiter of this.asks.values()) waiter?.({ type: 'gone' })
    this.asks.clear()
    this.channel.push({ t: 'exited', code })
    this.channel.close()
  }

  private write(frame: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify(frame)}\n`)
  }

  private key(eventId: string): string {
    return `line:${LINE_PROFILE.id}:${this.ref.providerSessionId}:${eventId}`
  }

  private emit(event: DriverEvent): void {
    if (!this.exited) this.channel.push(event)
  }
}

/** A single-consumer async stream that buffers until read and ends once closed and drained. */
class EventChannel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private readonly waiting: ((result: IteratorResult<T>) => void)[] = []
  private closed = false

  push(value: T): void {
    const reader = this.waiting.shift()
    if (reader === undefined) this.buffer.push(value)
    else reader({ value, done: false })
  }

  close(): void {
    this.closed = true
    for (const reader of this.waiting.splice(0)) reader({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffer.length > 0)
          return Promise.resolve({ value: this.buffer.shift() as T, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      }
    }
  }
}

// ---------- the line driver's in-memory fixture set (15 §6 layout, built with its variants) ----------

type Frame = Record<string, unknown>

/** The unknown field the `-with-extra` variant adds to every object (as `scrub.mjs` does, HR T1). */
function withExtraField(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withExtraField)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = withExtraField(item)
    out.dwarfaiUnknownField = 'extra'
    return out
  }
  return value
}

const jsonl = (frames: readonly Frame[]): string =>
  frames.map((frame) => `${JSON.stringify(frame)}\n`).join('')

/** A JSONL file with its `-with-extra` and `-crlf` variants. */
function jsonlFiles(stem: string, frames: readonly Frame[]): [string, string][] {
  const text = jsonl(frames)
  return [
    [`${stem}.jsonl`, text],
    [`${stem}-with-extra.jsonl`, jsonl(frames.map((frame) => withExtraField(frame) as Frame))],
    [`${stem}-crlf.jsonl`, text.replaceAll('\n', '\r\n')]
  ]
}

/** One case: the provider's lines, the timing of what the driver sends between them, the expected file. */
function lineCase(
  stem: string,
  order: readonly (Frame | 'sent')[],
  expected: Record<string, unknown>
): [string, string][] {
  const received = order.filter((item): item is Frame => item !== 'sent')
  const timing = order.map((item) =>
    item === 'sent'
      ? { stream: 'sent', bytes: 1 }
      : { stream: 'received', bytes: Buffer.byteLength(`${JSON.stringify(item)}\n`) }
  )
  return [
    ...jsonlFiles(stem, received),
    ...jsonlFiles(`${stem}-timing`, timing),
    [`${stem}.expected.json`, JSON.stringify(expected)]
  ]
}

const READY: Frame = { type: 'ready', session: 's-1' }
const PERMISSION: Frame = {
  type: 'permission',
  request: 'r-1',
  options: ['allow_once', 'reject_once'],
  tool: 'Bash',
  text: 'ls'
}
const ECHO = {
  t: 'message',
  record: {
    sourceKey: 'line:line-test:{session}:echo-m-1',
    role: 'person',
    text: 'list the files',
    providerTime: null,
    echoOf: '{session}:m-1'
  }
}
const ASK_OPENED = {
  t: 'ask.opened',
  ask: {
    kind: 'permission',
    providerRequestId: 'r-1',
    channel: 'driver',
    payload: { toolName: 'Bash', requestText: 'ls' },
    options: { hasAllowOnce: true, hasRejectOnce: true },
    turnKey: 'turn-1'
  }
}
const RECEIPT = { confidence: 'unconfirmed', heldUntilTurnEnd: false, correlation: '{session}:m-1' }
const ASK_SCRIPT = [{ do: 'launch' }, { do: 'sendTurn', messageId: 'm-1', text: 'list the files' }]
const PROMPT_SENT = { type: 'prompt', id: 'm-1', text: 'list the files' }

/** The line driver's fixtures, written by hand from 15 §1.3, §1.4 and §6. */
export function lineFixtureFiles(): Map<string, string> {
  return new Map<string, string>([
    [
      'meta.json',
      JSON.stringify({
        providerVersion: '1.0.0',
        capturedAt: '2026-10-15',
        capturedBy: 'ci-synthetic',
        os: 'any',
        scrubbed: true,
        capabilities: {}
      })
    ],
    ...lineCase('c-01-launch', [READY], {
      case: 'C-01',
      script: [{ do: 'launch' }],
      outcomes: [{ resolved: true }],
      events: [],
      sent: []
    }),
    ...lineCase(
      'c-15-never-acknowledged',
      [READY, 'sent', PERMISSION, 'sent', { type: 'ack', request: 'r-1' }],
      {
        case: 'C-15',
        script: [
          ...ASK_SCRIPT,
          { do: 'answerPermission', providerRequestId: 'r-1', decision: 'allow' },
          { do: 'advance', ms: 29_999 },
          { do: 'advance', ms: 1 }
        ],
        outcomes: [
          { resolved: true },
          RECEIPT,
          { kind: 'refused', reason: 'channel-unavailable' },
          null,
          null
        ],
        events: [{ t: 'status', value: 'working' }, ECHO, ASK_OPENED],
        sent: [PROMPT_SENT, { type: 'reply', request: 'r-1', option: 'allow_once' }]
      }
    )
  ])
}
