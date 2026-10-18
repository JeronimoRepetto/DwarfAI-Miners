// AntigravityNdjsonDriver (15 §4.8, `ndjson`; 15 §3 row A1): launches the person's own `agy` with
// `--input-format stream-json --output-format stream-json` through the kernel `ProcessControl`
// (argv array, `shell: false` fixed in the adapter, process-group leader), with the `childEnv`
// allowlist (15 §4). The prompt and every turn go on stdin as one `{"event":"user",...}` line
// each; `-p` is never used. stdout is read by `streamParser`. Development builds only: the
// profile is `publicLaunch: 'gated'`, which the catalogue and the registry apply from the one
// build flag (ADR-009 D6); this driver never reads the build or a provider id.
//
// Readiness (row A1 `earlyFailure: 'exit-only'`, ADR-020 D4): an exit before `t0 + 3 s` is
// `exited-at-once`. A launch is ready once that window passed with no exit AND the `init` line
// named the conversation, because the conversation id is the session's identity (15 §4.8, §1.5;
// bound before the dwarf is published, ADR-015 item 7). A live agy that names no conversation by
// HANDSHAKE_TIMEOUT_MS is `could-not-start`. An agy that ends after the window without naming one
// is a session that ran and ended (ADR-020 D4): it resolves as an ended session whose ref holds
// `unnamed:<launchId>`, which no resume accepts (package gap, decided here).
//
// Resume (AMENDMENT-13, OQ-81; ADR-015): the launch argv (its model and effort included) plus
// `--conversation <conversationId>`; it writes nothing and is ready at `t0 + 3 s` with no exit.
//
// No ask: agy hands no permission and no question to a host on this stream, so every answer is
// `ask-closed`, and no permission mode is offered until SP-10 records a deny policy (15 §2.8); a
// request that names one is refused before any spawn. No interrupt (the stream has no cancel), no
// usage (row A1 U→0), no adopt. The driver never signals a process: ending one is ADR-014's
// `SessionTerminator` (`close('end-thread')` closes stdin, then the tree kill); the only process it
// ends is a `--help` probe that outlived PROBE_TIMEOUT_MS, by identity. No provider credential is
// read, copied or forwarded (ADR-008 item 2): the child environment is the allowlist.
//
// Candidate decision (21 §6, TC-156-03): `src/main/sessionLaunch/antigravityHeldSession.ts` is
// replaced, its rules carried over. Its 35 tests pass unchanged at its own seam, but it spawns
// through `node:child_process` (R17) with the whole `process.env` (15 §4 `childEnv`), kills by a
// bare pid, has no early-failure window, no sourceKeys, no resume and speaks the legacy
// `HeldSessionPort` and Feed types (R16), so it cannot run the 15 §6 suite. Kept: the argv shape,
// the user line, the delta rule (one message per step at DONE), one activity per tool step, the
// result status vocabulary, skip-not-throw on drift and stderr never ingested.
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import type { ProcessIdentity } from '../../../../../kernel/domain/processIdentity'
import type { AnswerOutcome } from '../../../../../kernel/domain/sharedContracts'
import type { Clock } from '../../../../../kernel/ports/clock'
import type { ProcessControl, SpawnedProcess } from '../../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../../kernel/ports/scheduler'
import { detectForDriver, type InstallDetection } from '../../../application/detection'
import { PROBE_TIMEOUT_MS } from '../../../application/probe'
import type { ProviderCapabilities } from '../../../domain/capabilities'
import { combineLowest, merge } from '../../../domain/mergeCapabilities'
import type { CatalogRecord, ProviderProfile } from '../../../domain/profile'
import type {
  CloseOutcome,
  DetectResult,
  DriverEvent,
  DriverLaunchError,
  DriverLaunchRequest,
  DriverResumeError,
  DriverSendError,
  DriverSession,
  InstalledProvider,
  ProviderDriver,
  SendReceipt,
  SessionRef,
  TurnInput
} from '../../../ports/providerDriver'
import { probeEnv } from '../../install/searchDirs'
import { adapterLaunch, type LaunchTarget } from '../acp/client/adapterLaunch'
import { childEnv, type LoginEnvironment } from '../shared/childEnv'
import { buildArgv } from './argv'
import { capabilitiesFromHelp } from './capabilities'
import { EventChannel } from './eventChannel'
import { LineFramer, parseLine, toolSummary, turnEndOf, type StreamRecord } from './streamParser'

/** 15 §0: the readiness bound of a launch (here: the init line naming the conversation). */
export const HANDSHAKE_TIMEOUT_MS = 30_000
/** ADR-020 D4: an exit before readiness inside this window is `exited-at-once`. */
export const EARLY_FAILURE_WINDOW_MS = 3_000
/**
 * How long the output's end and the exit may lie apart (an adapter choice within ADR-014's 2 s):
 * output end with no exit by then is `transport-lost`; an exit with output still open by then is
 * reported `exited` anyway (a grandchild may hold the pipe).
 */
export const OUTPUT_DRAIN_MS = 2_000
/** ADR-020 D1, D6: the output tail a launch failure carries, at most. */
const TAIL_CHARS = 400
/** A `--help` probe reads at most this much. */
const HELP_READ_CHARS = 256 * 1024
/** The program that runs a Windows script entry (ADR-029 row 8, #1360). */
const NODE_BINARY = 'node'
/** A conversation id agy could be handed back as one `--conversation` value. */
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type Platform = 'win32' | 'darwin' | 'linux'

export interface AntigravityNdjsonDriverDeps {
  /** The Antigravity catalog record: profile, ceiling and documented variables (`profiles.ts`). */
  readonly record: CatalogRecord
  /** The one install detection behind every `detect()` (ADR-009 D5; 15 §2.4 row Antigravity). */
  readonly detection: InstallDetection
  readonly processControl: ProcessControl
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** The person's login environment `childEnv` copies named variables from (15 §4). */
  readonly loginEnv: LoginEnvironment
  /** The folder a `--help` probe runs in (the person's home). */
  readonly home: string
  readonly platform: Platform
  /** One-line redaction of activity summaries (`contracts/logging` `redactSecrets`, bound by wiring). */
  readonly redact: (text: string) => string
  /**
   * What a resume needs that `SessionRef` does not carry, read from the stored launch record when
   * this driver instance did not launch the session (a restarted Host): its folder and spawn tag.
   * Bound by host/wiring; the driver never imports launching (R3, R4). Absent or null: unknown.
   */
  readonly resumeContext?: (ref: SessionRef) => { cwd: string; spawnTag: string } | null
}

/** What a resume repeats of its launch (package gap: `SessionRef` carries none of it). */
interface Remembered {
  readonly cwd: string
  readonly spawnTag: string
  readonly model?: string
  readonly effort?: string
}

export class AntigravityNdjsonDriver implements ProviderDriver {
  readonly profile: ProviderProfile
  readonly transport = 'ndjson' as const
  private readonly launchIds = new Set<string>()
  /** Conversations whose process this Host holds now (ADR-015: never two writers). */
  private readonly live = new Set<string>()
  private readonly remembered = new Map<string, Remembered>()
  /** The last probe per install (binary, version, mtime): the session's probe source (15 §2.1). */
  private readonly probed = new Map<string, ProviderCapabilities>()

  constructor(private readonly deps: AntigravityNdjsonDriverDeps) {
    this.profile = deps.record.profile
  }

  detect(): Promise<DetectResult> {
    return detectForDriver(this.deps.detection, {
      providerId: this.profile.id,
      binaries: this.profile.binaries
    })
  }

  async probe(install: InstalledProvider): Promise<ProviderCapabilities> {
    let help: string | null
    try {
      help = await this.readHelp(install)
    } catch {
      help = null
    }
    const caps = merge(this.deps.record.ceiling, capabilitiesFromHelp(help))
    this.probed.set(installKey(install), caps)
    return structuredClone(caps)
  }

  async launch(req: DriverLaunchRequest): Promise<DriverSession> {
    if (this.launchIds.has(req.launchId)) {
      throw launchError('could-not-start', 'launch id already used')
    }
    this.launchIds.add(req.launchId)
    if (req.permissionMode !== null) {
      // 15 §2.8: no deny policy is recorded (SP-10), so the profile offers no mode at all.
      throw launchError('could-not-start', 'agy is offered no permission mode until SP-10')
    }
    if (req.delegation !== null) {
      throw launchError('could-not-start', 'agy takes no delegation entry (mcpInjection none)')
    }
    let argv: string[]
    let env: Record<string, string>
    try {
      argv = buildArgv({
        ...(req.model === undefined ? {} : { model: req.model }),
        ...(req.effort === undefined ? {} : { effort: req.effort })
      })
      env = this.childEnvOf(req.spawnTag)
    } catch (error) {
      if (error instanceof HostInvariantError) throw launchError('could-not-start', error.message)
      throw error
    }
    const target = await this.startTarget(req.install.binaryPath)
    const spawnedAt = this.deps.clock.now()
    const child = this.spawn(target, argv, req.cwd, env)
    let identity: ProcessIdentity
    try {
      identity = await child.identity
    } catch (error) {
      throw spawnFailure(error)
    }
    try {
      await req.onSpawned(identity)
    } catch {
      child.stdin?.end()
      throw launchError('could-not-start', 'the spawned process could not be recorded')
    }
    const session = new NdjsonSession({
      child,
      ref: {
        providerId: this.profile.id,
        providerSessionId: `unnamed:${req.launchId}`,
        pid: identity.pid,
        processStartTimeMs: identity.processStartTimeMs
      },
      named: false,
      capabilities: this.sessionCapabilities(req.install),
      spawnedAt,
      deps: this.deps,
      fail: (early, detail, tail) =>
        launchError(early ? 'exited-at-once' : 'could-not-start', detail, tail),
      onExit: (ref) => this.live.delete(ref.providerSessionId)
    })
    session.writePrompt(req.prompt)
    const ready = await session.ready
    if (session.named) {
      this.live.add(ready.ref.providerSessionId)
      this.remembered.set(ready.ref.providerSessionId, {
        cwd: req.cwd,
        spawnTag: req.spawnTag,
        ...(req.model === undefined ? {} : { model: req.model }),
        ...(req.effort === undefined ? {} : { effort: req.effort })
      })
    }
    return ready
  }

  async resume(ref: SessionRef): Promise<DriverSession> {
    const conversationId = ref.providerSessionId
    if (this.live.has(conversationId)) {
      throw resumeError('resume-error', 'the conversation is live in this Host')
    }
    if (!CONVERSATION_ID.test(conversationId)) {
      throw resumeError('stale-ref', 'agy named no conversation for this session')
    }
    const known = this.remembered.get(conversationId) ?? this.deps.resumeContext?.(ref) ?? undefined
    if (known === undefined) {
      throw resumeError('resume-error', 'the folder and spawn tag of the session are unknown')
    }
    const detected = await this.detect()
    if (detected.kind !== 'installed') throw launchError('not-installed', 'agy is not installed')
    let argv: string[]
    let env: Record<string, string>
    try {
      const tuning = known as Partial<Remembered>
      argv = buildArgv({
        ...(tuning.model === undefined ? {} : { model: tuning.model }),
        ...(tuning.effort === undefined ? {} : { effort: tuning.effort }),
        conversationId
      })
      env = this.childEnvOf(known.spawnTag)
    } catch (error) {
      if (error instanceof HostInvariantError) throw resumeError('resume-error', error.message)
      throw error
    }
    const target = await this.startTarget(detected.install.binaryPath)
    const spawnedAt = this.deps.clock.now()
    const child = this.spawn(target, argv, known.cwd, env)
    let identity: ProcessIdentity
    try {
      identity = await child.identity
    } catch (error) {
      const failure = spawnFailure(error)
      if (failure.cause === 'not-installed') throw failure
      throw resumeError('resume-error', failure.detail)
    }
    const session = new NdjsonSession({
      child,
      ref: {
        providerId: this.profile.id,
        providerSessionId: conversationId,
        pid: identity.pid,
        processStartTimeMs: identity.processStartTimeMs
      },
      named: true,
      capabilities: this.sessionCapabilities(detected.install),
      spawnedAt,
      deps: this.deps,
      fail: (_early, detail) => resumeError('resume-error', detail),
      onExit: (exited) => this.live.delete(exited.providerSessionId)
    })
    const resumed = await session.ready
    this.live.add(resumed.ref.providerSessionId)
    this.remembered.set(resumed.ref.providerSessionId, known)
    return resumed
  }

  /** 15 §2.1: the ceiling merged with the protocol (nothing negotiated) and the probe source. */
  private sessionCapabilities(install: InstalledProvider): ProviderCapabilities {
    const probe =
      this.probed.get(installKey(install)) ??
      merge(this.deps.record.ceiling, capabilitiesFromHelp(null))
    return merge(this.deps.record.ceiling, combineLowest({}, probe))
  }

  private childEnvOf(spawnTag: string): Record<string, string> {
    return childEnv(this.deps.loginEnv, spawnTag, {
      providerVars: this.deps.record.providerEnvVars ?? [],
      loopbackRelay: false,
      platform: this.deps.platform
    })
  }

  /**
   * How to start the person's agy, resolved like a binary (ADR-009 D5). agy's own install is an
   * executable started as it is; a Windows install the one resolver answers as a script entry
   * (an `agy.cmd` shim, #1360) cannot be started by the OS and R17 forbids a shell, so the
   * person's `node`, found through the same detection, runs it (`adapterLaunch`). Not installed
   * when that `node` does not resolve: no spawn.
   */
  private async startTarget(binaryPath: string): Promise<LaunchTarget> {
    const target = await adapterLaunch(binaryPath, this.deps.platform, async () => {
      const found = await this.deps.detection.detect({
        providerId: this.profile.id,
        binaries: [NODE_BINARY]
      })
      return found.kind === 'installed' ? found.install.binaryPath : null
    })
    if (target === null) {
      throw launchError(
        'not-installed',
        `${NODE_BINARY}, which runs ${this.profile.label}, is not installed`
      )
    }
    return target
  }

  private spawn(
    target: LaunchTarget,
    args: readonly string[],
    cwd: string,
    env: Record<string, string>
  ): SpawnedProcess {
    return this.deps.processControl.spawn({
      executable: target.program,
      args: [...target.leadingArgs, ...args],
      cwd,
      env,
      processGroup: 'own',
      stdio: 'pipe'
    })
  }

  /**
   * `agy --help` with an argv array and the probe environment, bounded by PROBE_TIMEOUT_MS; a
   * program still running then is ended by identity. Null when it did not answer in time.
   */
  private async readHelp(install: InstalledProvider): Promise<string | null> {
    const { processControl, scheduler, loginEnv, platform, home } = this.deps
    const target = await this.startTarget(install.binaryPath)
    const child = processControl.spawn({
      executable: target.program,
      args: [...target.leadingArgs, '--help'],
      cwd: home,
      env: probeEnv(loginEnv, platform),
      processGroup: 'own',
      stdio: 'pipe'
    })
    child.identity.catch(() => undefined)
    child.stdin?.end()
    child.stderr?.resume()
    let stdout = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < HELP_READ_CHARS) stdout += chunk
    })
    const finished = Promise.all([
      child.exited,
      new Promise<void>((resolve) => {
        if (child.stdout === null) resolve()
        else child.stdout.once('end', () => resolve()).once('close', () => resolve())
      })
    ]).then(
      () => stdout,
      () => null
    )
    let timer: { cancel(): void } | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = scheduler.after(PROBE_TIMEOUT_MS, () => resolve('late'))
    })
    const outcome = await Promise.race([finished, late])
    timer?.cancel()
    if (outcome !== 'late') return outcome
    void child.identity.then(
      (identity) => processControl.killTree(identity, { graceMs: 0, group: 'owned' }),
      () => undefined
    )
    return null
  }
}

// ---------- one session ----------

interface SessionOptions {
  readonly child: SpawnedProcess
  readonly ref: SessionRef
  /** A resume knows its conversation; a launch learns it from the init line. */
  readonly named: boolean
  readonly capabilities: ProviderCapabilities
  readonly spawnedAt: number
  readonly deps: AntigravityNdjsonDriverDeps
  /** The rejection of a start that failed (`early`: exit inside the 3 s window). */
  readonly fail: (early: boolean, detail: string, tail: string) => unknown
  readonly onExit: (ref: SessionRef) => void
}

/** A line written to stdin, waiting for the `user_input` step that echoes it. */
interface PendingEcho {
  readonly text: string
  readonly echoOf: string | null
  /** Which turn of this session it opened (1-based). */
  readonly turn: number
}

class NdjsonSession implements DriverSession {
  ref: SessionRef
  readonly capabilities: ProviderCapabilities
  named: boolean
  readonly ready: Promise<DriverSession>
  private readonly channel = new EventChannel<DriverEvent>()
  private readonly framer = new LineFramer()
  private settleReady: ((outcome: 'ready' | 'failed', detail: string) => void) | null = null
  private windowPassed = false
  private readonly handshakeTimer: { cancel(): void }
  private readonly windowTimer: { cancel(): void }
  private stderrTail = ''
  private openTurns = 0
  private written = 0
  private results = 0
  private readonly pending: PendingEcho[] = []
  private readonly echoed = new Set<number>()
  private readonly saying = new Map<number, string>()
  private readonly said = new Set<number>()
  private readonly tools = new Map<number, { toolName: string; summary: string; done: boolean }>()
  private readonly ended = new Set<string>()
  private readonly reported = new Set<string>()
  private initSeen = false
  private closing = false
  private outputEnded = false
  private exitSeen = false
  private exitCode: number | null = null
  private exited = false
  private drainTimer: { cancel(): void } | null = null
  private lostTimer: { cancel(): void } | null = null

  constructor(private readonly options: SessionOptions) {
    this.ref = { ...options.ref }
    this.named = options.named
    this.capabilities = structuredClone(options.capabilities)
    const { child, deps } = options
    this.ready = new Promise<DriverSession>((resolve, reject) => {
      this.settleReady = (outcome, detail) => {
        this.settleReady = null
        this.handshakeTimer.cancel()
        this.windowTimer.cancel()
        if (outcome === 'ready') {
          resolve(this)
          return
        }
        const early = deps.clock.now() - options.spawnedAt < EARLY_FAILURE_WINDOW_MS
        // 15 §1.3: the driver closes its transport; launching kills the tree (ADR-014).
        this.closeInput()
        reject(options.fail(early && detail !== 'handshake timeout', detail, this.tail()))
      }
    })
    const left = options.spawnedAt + EARLY_FAILURE_WINDOW_MS - deps.clock.now()
    this.windowTimer = deps.scheduler.after(Math.max(0, left), () => {
      this.windowPassed = true
      this.maybeReady()
    })
    this.handshakeTimer = deps.scheduler.after(HANDSHAKE_TIMEOUT_MS, () =>
      this.settleReady?.('failed', 'handshake timeout')
    )
    // An unhandled EPIPE on stdin would take the Host down; a broken pipe fails the next write.
    child.stdin?.on('error', () => undefined)
    child.stderr?.setEncoding('utf8')
    // stderr is never conversation: kept only as the tail of a failed start (ADR-020 D6).
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-TAIL_CHARS * 4)
    })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const line of this.framer.push(chunk)) this.handle(parseLine(line))
    })
    child.stdout?.on('end', () => this.outputEnd())
    void child.exited.then(
      (outcome) => this.processExit(outcome.code),
      () => this.processExit(null)
    )
  }

  events(): AsyncIterable<DriverEvent> {
    return this.channel
  }

  /** The launch's first turn: its user line. */
  writePrompt(text: string): void {
    this.writeUser(text, null)
  }

  async sendTurn(input: TurnInput): Promise<SendReceipt> {
    if (this.exited || this.closing) {
      throw sendError('session-closed', 'the session has ended')
    }
    if (input.attachments.length > 0) {
      throw sendError('channel-error', 'this driver does not send attachments')
    }
    const held = this.writeUser(input.text, input.messageId)
    if (held === null) throw sendError('channel-error', 'the stdin of agy refused the line')
    // The stream acknowledges no stdin line: written, not confirmed (row A1 reactionEvidence none).
    return { confidence: 'unconfirmed', heldUntilTurnEnd: held, correlation: input.messageId }
  }

  /** `interrupt` is false on this driver (15 §3 row A1): the caller goes to ADR-014's kill. */
  async interrupt(): Promise<void> {}

  /** No ask is ever opened on this stream (15 §4.8): every answer is for a closed ask. */
  async answerPermission(): Promise<AnswerOutcome> {
    return { kind: 'refused', reason: 'ask-closed' }
  }

  async answerQuestion(): Promise<AnswerOutcome> {
    return { kind: 'refused', reason: 'ask-closed' }
  }

  async close(mode: 'detach' | 'end-thread'): Promise<CloseOutcome> {
    if (mode === 'detach') return { kind: 'failed', reason: 'unsupported' }
    this.closeInput()
    return { kind: 'closed' }
  }

  // ---------- writing ----------

  /**
   * One user line (15 §4.8): `JSON.stringify` keeps a multi-line text on one line. Returns whether
   * it queues behind a running turn, or null when the pipe refused it (nothing is opened then).
   */
  private writeUser(text: string, echoOf: string | null): boolean | null {
    const stdin = this.options.child.stdin
    if (stdin === null) return null
    // The turn opens before the write: agy's answer may arrive while the write is still on the stack.
    const held = this.openTurns > 0
    const pending: PendingEcho = { text, echoOf, turn: this.written + 1 }
    this.pending.push(pending)
    this.written += 1
    this.openTurns += 1
    if (!held) this.emit({ t: 'status', value: 'working' })
    try {
      stdin.write(`${JSON.stringify({ event: 'user', message: { content: text } })}\n`)
    } catch {
      // A refused line opened nothing: no echo waits for it and no turn is counted.
      const at = this.pending.indexOf(pending)
      if (at !== -1) this.pending.splice(at, 1)
      this.written -= 1
      this.openTurns = Math.max(0, this.openTurns - 1)
      if (!held && this.openTurns === 0) this.emit({ t: 'status', value: 'idle' })
      return null
    }
    return held
  }

  private closeInput(): void {
    if (this.closing) return
    this.closing = true
    this.options.child.stdin?.end()
  }

  // ---------- reading ----------

  private handle(record: StreamRecord): void {
    switch (record.kind) {
      case 'init':
        this.onInit(record.conversationId)
        return
      case 'step':
        this.onStep(record)
        return
      case 'result':
        this.onResult(record.status, record.numTurns)
        return
      case 'drift':
        this.reportOnce(`drift:${record.detail}`, { kind: 'protocol-drift', detail: record.detail })
        return
    }
  }

  /** The init line names the conversation: the launch's identity (15 §4.8). */
  private onInit(conversationId: string | null): void {
    if (this.initSeen || conversationId === null) return
    this.initSeen = true
    if (!this.named) {
      this.ref = { ...this.ref, providerSessionId: conversationId }
      this.named = true
    } else if (conversationId !== this.ref.providerSessionId) {
      // ADR-015 item 7: a resume that continues under a new id names the one it continued.
      const previous = this.ref.providerSessionId
      this.ref = {
        ...this.ref,
        providerSessionId: conversationId,
        previousProviderSessionId: previous
      }
    }
    this.maybeReady()
  }

  private onStep(step: Extract<StreamRecord, { kind: 'step' }>): void {
    switch (step.type) {
      case 'user_input':
        this.onUserInput(step.index)
        return
      case 'agent_response':
        this.onReply(step.index, step.textDelta, step.done)
        return
      case 'tool':
        this.onTool(step)
        return
      case 'checkpoint':
        return
    }
  }

  /** The CLI's own user step carries no text: it echoes the oldest line written (ADR-007 item 3). */
  private onUserInput(index: number): void {
    if (this.echoed.has(index)) return
    this.echoed.add(index)
    const line = this.pending.shift()
    if (line === undefined) return
    this.emit({
      t: 'message',
      record: {
        sourceKey: this.key(String(index)),
        role: 'person',
        text: line.text,
        providerTime: null,
        ...(line.echoOf === null ? {} : { echoOf: line.echoOf })
      }
    })
  }

  /** `text_delta` is a true delta: accumulated per step, published once at DONE. */
  private onReply(index: number, delta: string, done: boolean): void {
    if (this.said.has(index)) return
    const text = (this.saying.get(index) ?? '') + delta
    if (!done) {
      this.saying.set(index, text)
      return
    }
    this.saying.delete(index)
    this.said.add(index)
    const trimmed = text.trim()
    // A reply that said nothing is no message (it was only thinking).
    if (trimmed === '') return
    this.emit({
      t: 'message',
      record: {
        sourceKey: this.key(String(index)),
        role: 'dwarf',
        text: trimmed,
        providerTime: null
      }
    })
  }

  /** One activity started at the first sight of a tool step, and finished at its DONE. */
  private onTool(step: Extract<StreamRecord, { kind: 'step' }>): void {
    if (step.toolName === null) return
    let tool = this.tools.get(step.index)
    if (tool === undefined) {
      tool = {
        toolName: step.toolName,
        summary: toolSummary(step.toolName, step.parameters, this.options.deps.redact),
        done: false
      }
      this.tools.set(step.index, tool)
      this.emitTool(step.index, tool, 'started')
    }
    if (step.done && !tool.done) {
      tool.done = true
      this.emitTool(step.index, tool, 'finished')
    }
  }

  private emitTool(
    index: number,
    tool: { toolName: string; summary: string },
    state: 'started' | 'finished'
  ): void {
    this.emit({
      t: 'activity',
      step: {
        sourceKey: this.key(String(index)),
        turnKey: null,
        kind: 'tool',
        toolName: tool.toolName,
        summary: tool.summary,
        state,
        at: null
      }
    })
  }

  /**
   * A result line ends its turn (ADR-021 item 5), as an inferred end: row A1 `turnEnd` is none.
   * The turn key is the result's own `num_turns` (it has no id; ADR-021 D1). Echoes still waiting
   * for a turn that ended are dropped, so a later user step never echoes the wrong line.
   */
  private onResult(status: string | null, numTurns: number | null): void {
    const end = turnEndOf(status)
    if (end === null) return
    this.results += 1
    const turn = numTurns ?? this.results
    const turnKey = this.key(`turn:${turn}`)
    if (this.ended.has(turnKey)) return
    this.ended.add(turnKey)
    while (this.pending[0] !== undefined && this.pending[0].turn <= this.results) {
      this.pending.shift()
    }
    this.emit({
      t: 'turn.ended',
      end: {
        turnKey,
        kind: end.kind,
        at: this.options.deps.clock.now(),
        reliability: 'inferred',
        cancelledFromApp: false,
        ...(end.detail === undefined ? {} : { detail: end.detail })
      }
    })
    if (this.openTurns === 0) return
    this.openTurns -= 1
    if (this.openTurns === 0) this.emit({ t: 'status', value: 'idle' })
  }

  // ---------- readiness and the end ----------

  /** Ready once the early-failure window passed and the conversation is named. */
  private maybeReady(): void {
    if (this.windowPassed && this.named) this.settleReady?.('ready', 'ready')
  }

  /** stdout ended: with the exit observed now or within OUTPUT_DRAIN_MS, the normal end (C-18). */
  private outputEnd(): void {
    if (this.outputEnded) return
    const last = this.framer.flush()
    if (last !== null) this.handle(parseLine(last))
    this.outputEnded = true
    if (this.exitSeen) {
      this.exit()
      return
    }
    this.lostTimer = this.options.deps.scheduler.after(OUTPUT_DRAIN_MS, () => {
      this.lostTimer = null
      if (this.exited || this.exitSeen || this.settleReady !== null) return
      this.emit({
        t: 'error',
        cause: { kind: 'transport-lost', detail: 'agy closed its output and did not exit' }
      })
    })
  }

  private processExit(code: number | null): void {
    if (this.exitSeen) return
    this.exitSeen = true
    this.exitCode = code
    // The process is gone: its conversation may be resumed (no second writer, ADR-015).
    this.options.onExit(this.ref)
    if (this.settleReady !== null) {
      const elapsed = this.options.deps.clock.now() - this.options.spawnedAt
      if (elapsed < EARLY_FAILURE_WINDOW_MS) {
        this.settleReady('failed', `agy exited with code ${String(code)} before readiness`)
      } else {
        // ADR-020 D4: past the window, an exit is the session's own end, never a failed launch.
        this.windowPassed = true
        this.settleReady('ready', 'ended')
      }
    }
    if (this.outputEnded) {
      this.exit()
      return
    }
    this.drainTimer = this.options.deps.scheduler.after(OUTPUT_DRAIN_MS, () => this.exit())
  }

  /** `exited` is the last event, exactly once (15 §1.4). */
  private exit(): void {
    if (this.exited) return
    this.exited = true
    this.drainTimer?.cancel()
    this.lostTimer?.cancel()
    this.tools.clear()
    this.channel.push({ t: 'exited', code: this.exitCode })
    this.channel.close()
  }

  // ---------- helpers ----------

  /** 15 §4.8: `sourceKey = antigravity:antigravity:<conversationId>:<eventId>`. */
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

function installKey(install: InstalledProvider): string {
  return JSON.stringify([install.binaryPath, install.version, install.statMtimeMs])
}

function launchError(
  cause: DriverLaunchError['cause'],
  detail: string,
  tail = ''
): DriverLaunchError {
  return { cause, detail, ...(tail === '' ? {} : { toolOutputTail: tail }) }
}

function resumeError(reason: DriverResumeError['reason'], detail?: string): DriverResumeError {
  return { reason, ...(detail === undefined ? {} : { detail }) }
}

function sendError(kind: DriverSendError['kind'], reason: string): DriverSendError {
  return { kind, reason }
}

/** ADR-020 D4: spawn ENOENT is `not-installed`; any other refusal is `could-not-start`. */
function spawnFailure(error: unknown): DriverLaunchError {
  const code = (error as { code?: unknown } | null)?.code
  const named = typeof code === 'string' ? code : 'failed'
  return launchError(named === 'ENOENT' ? 'not-installed' : 'could-not-start', `spawn ${named}`)
}
