// CodexAppServerDriver (15 §4.4; ADR-009 D4): the preferred Codex driver. It runs the person's own
// `codex app-server` over stdio through the kernel `ProcessControl` (argv array, `shell: false`
// fixed in the adapter, process-group leader so ADR-014 ends a wrapper's grandchild too), with
// the `childEnv` allowlist (15 §4), and speaks line-framed JSON-RPC through the shared
// `JsonRpcStdioClient` (HO-11). Readiness is the handshake `initialize` → `initialized` →
// `thread/start` (launch) or `thread/resume` (resume); the prompt and every turn then go as
// `turn/start`. A message sent during a turn is queued and starts its own turn when the open one
// completes (v1: no `turn/steer`).
//
// Asks: approvals and `item/tool/requestUserInput` are server requests answered only `accept` /
// `decline` (or the empty answer set); an answer is `accepted` once the provider reports the
// request resolved (`serverRequest/resolved`, the only acknowledgement Codex gives a reply); a
// request resolved without DwarfAI's answer is `ask.resolved` elsewhere (or cancelled, when
// DwarfAI interrupted its turn). Unknown requests are answered -32601 (fail closed, FM-070).
//
// FM-085 (L-07): when the `initialize` user agent names another originator than this connection's
// client, the server was started by another Codex host; a turn it runs is attributed (messages,
// steps, usage, turn end) only when the thread's rollout confirms it (`rolloutConfirms`), else the
// provider-error path is taken.
//
// Gates (ISSUE-325 records, Codex 0.153.4, Windows): SP-12 partial → the Jev entry is the
// `ticket-file` path-only form in argv (`argv.ts`); S-015-1 failed → no `adopt` (ADR-015 item 5):
// after a Host restart the thread is resumed with `thread/resume`.
//
// No provider credential is read (ADR-008 item 2: the token-refresh request is answered -32601),
// no auto-approve flag or option (ADR-008 item 3: `buildArgv`, `threadPolicy`), no delegation
// token anywhere but the credential file (ADR-013 item 2). The driver never signals a process:
// `close('end-thread')` interrupts an open turn, unsubscribes and archives the thread and ends the
// server's stdin; the tree kill is ADR-014's. The only process it ends is a `--help` probe that
// outlived PROBE_TIMEOUT_MS, by identity.
//
// Candidate decision (21 §6, TC-152-04), evidence: this driver's conformance run and the legacy
// suites run unchanged (`codexPermissions.test.ts` 9 tests, `resume.test.ts`, `queue.test.ts`):
// `src/main/providers/codex/queue.ts` and `resume.ts` are replaced — they gate `codex queue
// --thread` and `codex exec resume` for detached and observed threads, which this owned session
// never uses (its turns and its resume are the protocol's `turn/start` and `thread/resume`);
// `src/main/domain/codexPermissions.ts` is adapted into `permissionMapping.ts` (`threadPolicy`).
import type { ProcessIdentity } from '../../../../../kernel/domain/processIdentity'
import type { AnswerOutcome, QuestionAnswers } from '../../../../../kernel/domain/sharedContracts'
import type { Clock } from '../../../../../kernel/ports/clock'
import type { ProcessControl, SpawnedProcess } from '../../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../../kernel/ports/scheduler'
import { detectForDriver, type InstallDetection } from '../../../application/detection'
import { PROBE_TIMEOUT_MS } from '../../../application/probe'
import type { ProviderCapabilities } from '../../../domain/capabilities'
import { combineLowest, merge } from '../../../domain/mergeCapabilities'
import type { CatalogRecord, ProviderProfile } from '../../../domain/profile'
import type {
  AskInput,
  CloseOutcome,
  DelegationInjection,
  DetectResult,
  DriverErrorCause,
  DriverEvent,
  DriverLaunchError,
  DriverResumeError,
  DriverSendError,
  DriverSession,
  InstalledProvider,
  ProviderDriver,
  SendReceipt,
  SessionRef,
  TurnInput,
  DriverLaunchRequest
} from '../../../ports/providerDriver'
import { probeEnv } from '../../install/searchDirs'
import { childEnv, type LoginEnvironment } from '../shared/childEnv'
import {
  JsonRpcStdioClient,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse
} from '../shared/JsonRpcStdioClient'
import { buildArgv, type JevRelay } from './argv'
import { capabilitiesFromHelp } from './capabilities'
import { EventChannel } from './eventChannel'
import { activityOf, historyMessages, isToolItem, messageOf, readItemEvent } from './items'
import {
  KNOWN_REQUESTS,
  permissionReply,
  questionReply,
  readServerRequest,
  threadPolicy,
  type ApprovalKind
} from './permissionMapping'
import {
  errorCause,
  minus,
  rateLimitReached,
  readTokenUsage,
  turnEndOf,
  unitTokens,
  type TokenTotals
} from './usage'

/** 15 §0: the readiness bound of a launch or a resume. */
export const HANDSHAKE_TIMEOUT_MS = 30_000
/** ADR-020 D4: an exit before readiness inside this window is `exited-at-once`. */
export const EARLY_FAILURE_WINDOW_MS = 3_000
/** ADR-014 item 1: the graceful close / interrupt budget. */
export const CLOSE_BUDGET_MS = 2_000
/** ADR-020 D1, D6: the output tail a launch failure carries, at most. */
const TAIL_CHARS = 400
/** A `--help` probe reads at most this much. */
const HELP_READ_CHARS = 256 * 1024
/** The provider family and the provider id of every key (15 §1.5, §4.4 Keys). */
const FAMILY = 'codex'
/** Codex's refusal of a thread it has no rollout for (S-015-1 run 2: `no rollout found …`). */
const STALE_THREAD = /no rollout found|not found|unknown thread/i

export type Platform = 'win32' | 'darwin' | 'linux'

/** FM-085 (L-07): whether the thread's rollout confirms a turn that a foreign server ran. */
export type RolloutCheck = (check: {
  threadId: string
  rolloutPath: string | null
  turnId: string
}) => Promise<boolean>

export interface CodexAppServerDriverDeps {
  /** The Codex catalog record: profile, ceiling and documented variables (`profiles.ts`). */
  readonly record: CatalogRecord
  /** The one install detection behind every `detect()` (ADR-009 D5). */
  readonly detection: InstallDetection
  readonly processControl: ProcessControl
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** The person's login environment `childEnv` copies named variables from (15 §4). */
  readonly loginEnv: LoginEnvironment
  /** The folder a `--help` probe runs in (the person's home). */
  readonly home: string
  readonly platform: Platform
  /** `initialize.clientInfo`: who DwarfAI is to the server (also the user-agent suffix). */
  readonly clientInfo: { readonly name: string; readonly version: string }
  /** One-line redaction of request texts and step summaries (`redactSecrets`, bound by wiring). */
  readonly redact: (text: string) => string
  /** FM-085: the rollout check (wiring binds the observer's reader); absent: never confirmed. */
  readonly rolloutConfirms?: RolloutCheck
}

/** What a resume needs that `SessionRef` does not carry (package gap, recorded in the hand-off). */
interface Remembered {
  readonly cwd: string
  readonly spawnTag: string
}

export class CodexAppServerDriver implements ProviderDriver {
  readonly profile: ProviderProfile
  readonly transport = 'app-server-rpc' as const
  private readonly launchIds = new Set<string>()
  /** Thread ids whose server this Host holds now (ADR-015: never two writers). */
  private readonly live = new Set<string>()
  private readonly remembered = new Map<string, Remembered>()
  /** The last probe per install (binary, version, mtime): the session's probe source (15 §2.1). */
  private readonly probed = new Map<string, ProviderCapabilities>()

  constructor(private readonly deps: CodexAppServerDriverDeps) {
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
    let argv: string[]
    let policy: Record<string, string | boolean>
    try {
      argv = buildArgv(
        jevOf(req.delegation, this.deps.platform),
        req.permissionMode?.providerArgs.argv ?? []
      )
      policy = threadPolicy(req.permissionMode)
    } catch {
      throw launchError(
        'could-not-start',
        'the argv or the thread policy was refused (ADR-008 item 3)'
      )
    }
    const spawnedAt = this.deps.clock.now()
    const child = this.spawn(req.install.binaryPath, argv, req.cwd, req.spawnTag)
    let identity: ProcessIdentity
    try {
      identity = await child.identity
    } catch (error) {
      throw spawnFailure(error)
    }
    await req.onSpawned(identity)
    const session = new AppServerSession({
      child,
      identity,
      capabilities: this.sessionCapabilities(req.install),
      spawnedAt,
      deps: this.deps,
      providerId: this.profile.id,
      onExit: (ref) => this.live.delete(ref.providerSessionId)
    })
    await session.handshake({
      method: 'thread/start',
      params: { cwd: req.cwd, ...policy, ...(req.model === undefined ? {} : { model: req.model }) },
      fail: (early, detail, tail) =>
        launchError(early ? 'exited-at-once' : 'could-not-start', detail, tail)
    })
    const threadId = session.ref.providerSessionId
    this.live.add(threadId)
    this.remembered.set(threadId, { cwd: req.cwd, spawnTag: req.spawnTag })
    session.startFirstTurn(req.prompt, req.effort)
    return session
  }

  async resume(ref: SessionRef): Promise<DriverSession> {
    if (this.live.has(ref.providerSessionId)) {
      throw resumeError('resume-error', 'the thread is live in this Host')
    }
    const known = this.remembered.get(ref.providerSessionId)
    if (known === undefined) {
      throw resumeError('resume-error', 'the folder and spawn tag of the thread are unknown')
    }
    const detected = await this.detect()
    if (detected.kind !== 'installed') throw launchError('not-installed', 'codex is not installed')
    const spawnedAt = this.deps.clock.now()
    const child = this.spawn(
      detected.install.binaryPath,
      buildArgv(null),
      known.cwd,
      known.spawnTag
    )
    let identity: ProcessIdentity
    try {
      identity = await child.identity
    } catch (error) {
      const failure = spawnFailure(error)
      if (failure.cause === 'not-installed') throw failure
      throw resumeError('resume-error', failure.detail)
    }
    const session = new AppServerSession({
      child,
      identity,
      capabilities: this.sessionCapabilities(detected.install),
      spawnedAt,
      deps: this.deps,
      providerId: this.profile.id,
      resumedThreadId: ref.providerSessionId,
      onExit: (exited) => this.live.delete(exited.providerSessionId)
    })
    await session.handshake({
      method: 'thread/resume',
      params: { threadId: ref.providerSessionId },
      fail: (_early, detail, _tail, refusal) =>
        resumeError(
          refusal !== null && STALE_THREAD.test(refusal) ? 'stale-ref' : 'resume-error',
          detail
        )
    })
    this.live.add(session.ref.providerSessionId)
    this.remembered.set(session.ref.providerSessionId, known)
    return session
  }

  /** 15 §2.1: the ceiling merged with the protocol (it negotiates nothing) and the probe source. */
  private sessionCapabilities(install: InstalledProvider): ProviderCapabilities {
    const probe =
      this.probed.get(installKey(install)) ??
      merge(this.deps.record.ceiling, capabilitiesFromHelp(null))
    return merge(this.deps.record.ceiling, combineLowest({}, probe))
  }

  private spawn(
    executable: string,
    args: readonly string[],
    cwd: string,
    spawnTag: string
  ): SpawnedProcess {
    const env = childEnv(this.deps.loginEnv, spawnTag, {
      providerVars: this.deps.record.providerEnvVars ?? [],
      // The relay is a stdio MCP server codex starts itself, never a loopback HTTP endpoint.
      loopbackRelay: false,
      platform: this.deps.platform
    })
    return this.deps.processControl.spawn({
      executable,
      args,
      cwd,
      env,
      processGroup: 'own',
      stdio: 'pipe'
    })
  }

  /**
   * `codex --help` with an argv array and the probe environment, bounded by PROBE_TIMEOUT_MS; a
   * program still running then is ended by identity. Null when it did not answer in time.
   */
  private async readHelp(install: InstalledProvider): Promise<string | null> {
    const { processControl, scheduler, loginEnv, platform, home } = this.deps
    const child = processControl.spawn({
      executable: install.binaryPath,
      args: ['--help'],
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
  readonly identity: ProcessIdentity
  readonly capabilities: ProviderCapabilities
  readonly spawnedAt: number
  readonly deps: CodexAppServerDriverDeps
  readonly providerId: ProviderProfile['id']
  /** A resume knows its thread before the handshake; a launch learns it from `thread/start`. */
  readonly resumedThreadId?: string
  readonly onExit: (ref: SessionRef) => void
}

interface HandshakePlan {
  readonly method: 'thread/start' | 'thread/resume'
  readonly params: Record<string, unknown>
  /** The rejection of a failed handshake (`early`: exit inside the 3 s window). */
  readonly fail: (early: boolean, detail: string, tail: string, refusal: string | null) => unknown
}

/** One open ask: the server request it answers and, once answered, who waits for the outcome. */
interface OpenAsk {
  readonly id: JsonRpcId
  readonly turnId: string
  readonly approval: ApprovalKind | null
  readonly question: {
    questionIds: readonly string[]
    ask: Extract<AskInput, { kind: 'question' }>
  } | null
  waiter: ((outcome: AnswerOutcome) => void) | null
}

/** A turn/start DwarfAI sent: its echo correlation, and its turn id once the provider names it. */
interface StartedTurn {
  readonly correlation: string | null
  turnId: string | null
}

type Attributable = Extract<DriverEvent, { t: 'message' | 'activity' | 'usage' | 'turn.ended' }>

class AppServerSession implements DriverSession {
  ref: SessionRef
  readonly capabilities: ProviderCapabilities
  private readonly channel = new EventChannel<DriverEvent>()
  private readonly client: JsonRpcStdioClient
  private settleReady: ((ok: boolean, detail: string, refusal: string | null) => void) | null = null
  private stderrTail = ''
  private threadId: string | null
  private rolloutPath: string | null = null
  /** FM-085: the server was started by another client than this connection's. */
  private foreign = false
  private readonly asks = new Map<string, OpenAsk>()
  private readonly started: StartedTurn[] = []
  private readonly queued: { text: string; correlation: string }[] = []
  private readonly openTurns = new Set<string>()
  private readonly interrupted = new Set<string>()
  private readonly children = new Set<string>()
  private readonly baseline = new Map<string, TokenTotals>()
  private readonly latest = new Map<string, TokenTotals>()
  private readonly held = new Map<string, Attributable[]>()
  private lastTotals: TokenTotals | null = null
  private activeTurn: string | null = null
  private working = false
  private effort: string | undefined
  private readonly reported = new Set<string>()
  private closing = false
  private outputEnded = false
  private exitSeen = false
  private exitCode: number | null = null
  private exited = false

  constructor(private readonly options: SessionOptions) {
    const { child, identity, deps } = options
    this.threadId = options.resumedThreadId ?? null
    this.ref = {
      providerId: options.providerId,
      providerSessionId: options.resumedThreadId ?? '',
      pid: identity.pid,
      processStartTimeMs: identity.processStartTimeMs
    }
    this.capabilities = structuredClone(options.capabilities)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-TAIL_CHARS * 4)
    })
    if (child.stdout === null || child.stdin === null) {
      throw launchError('could-not-start', 'the app-server has no stdio')
    }
    this.client = new JsonRpcStdioClient({
      input: child.stdout,
      output: child.stdin,
      scheduler: deps.scheduler,
      onRequest: (request) => this.onRequest(request),
      onNotification: (notification) => this.onNotification(notification),
      onDrift: (detail) => this.reportOnce(`drift:${detail}`, { kind: 'protocol-drift', detail }),
      onEnd: () => this.outputEnd(),
      onStrayResponse: (response) => this.onStrayResponse(response)
    })
    void child.exited.then(
      (outcome) => this.processExit(outcome.code),
      () => this.processExit(null)
    )
  }

  events(): AsyncIterable<DriverEvent> {
    return this.channel
  }

  // ---------- the handshake ----------

  /** `initialize` → `initialized` → `thread/start` / `thread/resume`; resolves at readiness. */
  handshake(plan: HandshakePlan): Promise<void> {
    const { deps, spawnedAt } = this.options
    const ready = new Promise<void>((resolve, reject) => {
      const timer = deps.scheduler.after(HANDSHAKE_TIMEOUT_MS, () => {
        // 15 §1.3: on a handshake timeout the driver closes its transport and rejects.
        this.client.close()
        this.settleReady?.(false, 'handshake timeout', null)
      })
      this.settleReady = (ok, detail, refusal) => {
        this.settleReady = null
        timer.cancel()
        if (ok) {
          resolve()
          return
        }
        const early =
          detail !== 'handshake timeout' && deps.clock.now() - spawnedAt < EARLY_FAILURE_WINDOW_MS
        this.client.close()
        reject(plan.fail(early, detail, this.stderrTail.slice(-TAIL_CHARS), refusal))
      }
    })
    void this.runHandshake(plan)
    return ready
  }

  private async runHandshake(plan: HandshakePlan): Promise<void> {
    try {
      const init = await this.client.request('initialize', {
        clientInfo: { ...this.options.deps.clientInfo }
      })
      this.foreign = startedByAnotherClient(
        asRecord(init).userAgent,
        this.options.deps.clientInfo.name
      )
      this.client.notify('initialized', {})
      const result = asRecord(await this.client.request(plan.method, plan.params))
      const thread = asRecord(result.thread)
      const id = typeof thread.id === 'string' && thread.id !== '' ? thread.id : null
      if (id === null) {
        this.settleReady?.(false, `${plan.method} named no thread`, null)
        return
      }
      this.adoptThread(id, thread)
      this.settleReady?.(true, 'ready', null)
    } catch (error) {
      const failure = error as JsonRpcFailure
      // A lost transport is classified by the process exit that follows (ADR-020 D4).
      if (failure.kind === 'closed') return
      const refusal = failure.kind === 'error' ? failure.message : null
      this.settleReady?.(false, `${plan.method} failed: ${failure.kind}`, refusal)
    }
  }

  /** The thread the handshake bound: the ref, the rollout and, on a resume, the history replay. */
  private adoptThread(id: string, thread: Record<string, unknown>): void {
    const previous = this.options.resumedThreadId
    this.threadId = id
    this.rolloutPath = typeof thread.path === 'string' ? thread.path : null
    this.ref = {
      ...this.ref,
      providerSessionId: id,
      ...(previous !== undefined && previous !== id ? { previousProviderSessionId: previous } : {})
    }
    if (previous === undefined) return
    // ADR-006 item 1: the replay's keys are the live ones, so it adds no row.
    for (const message of historyMessages(thread)) {
      this.emit({
        t: 'message',
        record: {
          sourceKey: this.key(message.id),
          role: message.role,
          text: message.text,
          providerTime: null
        }
      })
    }
  }

  // ---------- turns ----------

  /** The launch's first turn: its prompt as `turn/start`, with no echo correlation. */
  startFirstTurn(prompt: string, effort: string | undefined): void {
    this.effort = effort
    void this.startTurn(prompt, null).catch(() => {
      this.reportOnce('first-turn', {
        kind: 'provider-error',
        detail: 'turn/start was refused',
        retryable: false
      })
    })
  }

  async sendTurn(input: TurnInput): Promise<SendReceipt> {
    if (this.exited || this.outputEnded || this.closing) {
      throw sendError('session-closed', 'the session has ended')
    }
    if (input.attachments.length > 0) {
      throw sendError('channel-error', 'this driver does not send attachments yet')
    }
    if (this.working) {
      // v1 queues a message sent during a turn (15 §4.4 Quirks: no turn/steer).
      this.queued.push({ text: input.text, correlation: input.messageId })
      return { confidence: 'unconfirmed', heldUntilTurnEnd: true, correlation: input.messageId }
    }
    try {
      const turnId = await this.startTurn(input.text, input.messageId)
      return {
        confidence: 'confirmed',
        heldUntilTurnEnd: false,
        correlation: input.messageId,
        ...(turnId === null ? {} : { providerTurnId: turnId })
      }
    } catch (error) {
      const failure = error as JsonRpcFailure
      if (failure.kind === 'timeout') {
        return { confidence: 'unconfirmed', heldUntilTurnEnd: false, correlation: input.messageId }
      }
      if (failure.kind === 'closed') throw sendError('session-closed', 'the session has ended')
      throw sendError('channel-error', 'turn/start was refused')
    }
  }

  /** Writes one `turn/start`; resolves the turn id its response names. */
  private async startTurn(text: string, correlation: string | null): Promise<string | null> {
    if (!this.working) {
      this.working = true
      this.emit({ t: 'status', value: 'working' })
    }
    const entry: StartedTurn = { correlation, turnId: null }
    this.started.push(entry)
    try {
      const result = asRecord(
        await this.client.request('turn/start', {
          threadId: this.threadId,
          input: [{ type: 'text', text }],
          ...(this.effort === undefined ? {} : { effort: this.effort })
        })
      )
      const turnId = asString(asRecord(result.turn).id)
      if (turnId !== null) this.bindTurn(turnId)
      return turnId
    } catch (error) {
      this.started.splice(this.started.indexOf(entry), 1)
      if (this.started.length === 0 && this.activeTurn === null) this.becomeIdle()
      throw error
    }
  }

  /** The provider named a turn: the oldest unnamed `turn/start` is it (one turn at a time). */
  private bindTurn(turnId: string): StartedTurn | null {
    const named = this.started.find((entry) => entry.turnId === turnId)
    if (named !== undefined) return named
    const next = this.started.find((entry) => entry.turnId === null)
    if (next === undefined) return null
    next.turnId = turnId
    return next
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeTurn
    if (turnId === null || this.interrupted.has(turnId) || this.exited) return
    this.interrupted.add(turnId)
    await this.client.request('turn/interrupt', { threadId: this.threadId, turnId }).then(
      () => undefined,
      () => undefined
    )
  }

  // ---------- answers ----------

  async answerPermission(req: {
    providerRequestId: string
    decision: 'allow' | 'deny'
  }): Promise<AnswerOutcome> {
    const ask = this.asks.get(req.providerRequestId)
    if (ask === undefined || ask.waiter !== null) return { kind: 'refused', reason: 'ask-closed' }
    if (ask.approval === null) return { kind: 'refused', reason: 'invalid-answer' }
    const reply = permissionReply(ask.approval, req.decision)
    if (reply === null) return { kind: 'refused', reason: 'invalid-answer' }
    return this.reply(ask, reply)
  }

  async answerQuestion(
    req:
      | { providerRequestId: string; answers: QuestionAnswers }
      | { providerRequestId: string; decline: true }
  ): Promise<AnswerOutcome> {
    const ask = this.asks.get(req.providerRequestId)
    if (ask === undefined || ask.waiter !== null) return { kind: 'refused', reason: 'ask-closed' }
    if (ask.question === null) return { kind: 'refused', reason: 'invalid-answer' }
    const reply = questionReply(
      { questionIds: ask.question.questionIds, ask: ask.question.ask },
      'decline' in req ? { decline: true } : { answers: req.answers }
    )
    if (reply === null) return { kind: 'refused', reason: 'invalid-answer' }
    return this.reply(ask, reply)
  }

  /** Writes the reply; the outcome waits for the provider's evidence (resolved, error, loss). */
  private reply(ask: OpenAsk, result: Record<string, unknown>): Promise<AnswerOutcome> {
    if (this.exited || this.outputEnded) {
      return Promise.resolve({ kind: 'refused', reason: 'channel-unavailable' })
    }
    return new Promise((resolve) => {
      ask.waiter = resolve
      if (!this.client.respond(ask.id, result)) {
        ask.waiter = null
        resolve({ kind: 'refused', reason: 'channel-unavailable' })
      }
    })
  }

  // ---------- close ----------

  async close(mode: 'detach' | 'end-thread'): Promise<CloseOutcome> {
    if (mode === 'detach') return { kind: 'failed', reason: 'unsupported' }
    if (this.closing) return { kind: 'closed' }
    this.closing = true
    if (this.exited || this.outputEnded) return { kind: 'closed' }
    const outcome = await this.withinBudget(this.endThread())
    this.client.close()
    return outcome
  }

  /** ADR-014 item 5: interrupt the open turn, then `thread/unsubscribe` + `thread/archive`. */
  private async endThread(): Promise<CloseOutcome> {
    try {
      const turnId = this.activeTurn
      if (turnId !== null && !this.interrupted.has(turnId)) {
        this.interrupted.add(turnId)
        await this.client.request('turn/interrupt', { threadId: this.threadId, turnId })
      }
      await this.client.request('thread/unsubscribe', { threadId: this.threadId })
      await this.client.request('thread/archive', { threadId: this.threadId })
      return { kind: 'closed' }
    } catch (error) {
      const failure = error as JsonRpcFailure
      if (failure.kind === 'closed') return { kind: 'closed' }
      return { kind: 'failed', reason: failure.kind === 'timeout' ? 'timeout' : 'protocol-error' }
    }
  }

  private withinBudget(work: Promise<CloseOutcome>): Promise<CloseOutcome> {
    return new Promise((resolve) => {
      const timer = this.options.deps.scheduler.after(CLOSE_BUDGET_MS, () =>
        resolve({ kind: 'failed', reason: 'timeout' })
      )
      void work.then((outcome) => {
        timer.cancel()
        resolve(outcome)
      })
    })
  }

  // ---------- reading: server requests ----------

  private onRequest(request: JsonRpcRequest): boolean {
    if (!KNOWN_REQUESTS.has(request.method)) return false
    const { redact } = this.options.deps
    const read = readServerRequest(request.method, request.params, redact)
    if (read.kind === 'decline') {
      this.client.respond(request.id, read.reply)
      return true
    }
    if (read.kind === 'malformed') {
      // 15 §1.4: fail closed — Deny, no ask, the drift reported once.
      if (read.reply !== null) this.client.respond(request.id, read.reply)
      const detail = `malformed server request ${request.method}`
      this.reportOnce(`drift:${detail}`, { kind: 'protocol-drift', detail })
      return true
    }
    const providerRequestId = String(request.id)
    this.asks.set(providerRequestId, {
      id: request.id,
      turnId: read.turnId,
      approval: read.kind === 'permission' ? read.approval : null,
      question:
        read.kind === 'question'
          ? { questionIds: read.questionIds, ask: { ...read.ask, providerRequestId } }
          : null,
      waiter: null
    })
    this.emit({ t: 'ask.opened', ask: { ...read.ask, providerRequestId } as AskInput })
    return true
  }

  /** A response that names no request of DwarfAI's: an error for an answered ask rejects it. */
  private onStrayResponse(response: JsonRpcResponse): void {
    const ask = this.asks.get(String(response.id))
    if (ask === undefined || ask.waiter === null || response.error === undefined) return
    this.asks.delete(String(response.id))
    ask.waiter?.({ kind: 'refused', reason: 'channel-rejected' })
  }

  // ---------- reading: notifications ----------

  private onNotification(notification: JsonRpcNotification): void {
    const params = asRecord(notification.params)
    switch (notification.method) {
      case 'serverRequest/resolved':
        this.onResolved(params)
        return
      case 'thread/started':
        this.onThreadStarted(params)
        return
      case 'turn/started':
        this.onTurnStarted(params)
        return
      case 'turn/completed':
        this.onTurnCompleted(params)
        return
      case 'item/started':
      case 'item/completed':
        this.onItem(params, notification.method === 'item/completed')
        return
      case 'thread/tokenUsage/updated':
        this.onTokenUsage(params)
        return
      case 'account/rateLimits/updated': {
        const reached = rateLimitReached(params)
        if (reached !== null) {
          this.reportOnce(`rate-limited:${String(reached.resetAt)}`, {
            kind: 'rate-limited',
            ...(reached.resetAt === undefined ? {} : { resetAt: reached.resetAt })
          })
        }
        return
      }
      case 'error': {
        if (!this.ownThread(params)) return
        const cause = errorCause(params)
        this.reportOnce(JSON.stringify(cause), cause)
        return
      }
      default:
        // Status, deltas, MCP startup, hooks, goals, remote control: nothing the session reports.
        return
    }
  }

  private ownThread(params: Record<string, unknown>): boolean {
    return this.threadId !== null && params.threadId === this.threadId
  }

  private onResolved(params: Record<string, unknown>): void {
    const id = params.requestId
    if (typeof id !== 'string' && typeof id !== 'number') return
    const ask = this.asks.get(String(id))
    if (ask === undefined) return
    this.asks.delete(String(id))
    if (ask.waiter !== null) {
      // DwarfAI's own answer reached the provider: accepted, and never ask.resolved (15 §1.4).
      ask.waiter({ kind: 'accepted' })
      return
    }
    const by = this.interrupted.has(ask.turnId) ? 'cancelled' : 'elsewhere'
    this.emit({ t: 'ask.resolved', providerRequestId: String(id), by })
  }

  private onThreadStarted(params: Record<string, unknown>): void {
    const thread = asRecord(params.thread)
    const id = asString(thread.id)
    if (id === null || id === this.threadId || this.threadId === null) return
    if (thread.parentThreadId !== this.threadId || this.children.has(id)) return
    this.children.add(id)
    // 15 §4.4: a subagent thread is its own identity.
    this.emit({
      t: 'subagent',
      childRef: { providerId: this.ref.providerId, providerSessionId: id },
      parentRef: { providerId: this.ref.providerId, providerSessionId: this.threadId }
    })
  }

  private onTurnStarted(params: Record<string, unknown>): void {
    if (!this.ownThread(params)) return
    const turnId = asString(asRecord(params.turn).id)
    if (turnId === null) return
    this.bindTurn(turnId)
    this.openTurns.add(turnId)
    this.activeTurn = turnId
    if (!this.working) {
      this.working = true
      this.emit({ t: 'status', value: 'working' })
    }
  }

  private onItem(params: Record<string, unknown>, completed: boolean): void {
    const event = readItemEvent(params)
    if (event === null || event.threadId !== this.threadId) return
    const turnId = event.turnId
    if (completed) {
      const message = messageOf(event.item)
      if (message !== null) {
        const echoOf =
          message.role === 'person' && turnId !== null ? this.correlationOf(turnId) : null
        this.attribute(turnId, {
          t: 'message',
          record: {
            sourceKey: this.key(event.id),
            role: message.role,
            text: message.text,
            providerTime: event.at,
            ...(echoOf === null ? {} : { echoOf })
          }
        })
        return
      }
    }
    if (!isToolItem(event.type)) return
    this.attribute(turnId, {
      t: 'activity',
      step: activityOf(event, this.key(event.id), completed, this.options.deps.redact)
    })
  }

  private correlationOf(turnId: string): string | null {
    return (
      this.started.find((entry) => entry.turnId === turnId)?.correlation ??
      this.bindTurn(turnId)?.correlation ??
      null
    )
  }

  private onTokenUsage(params: Record<string, unknown>): void {
    const usage = readTokenUsage(params)
    if (usage === null || usage.threadId !== this.threadId) return
    if (this.openTurns.has(usage.turnId)) {
      if (!this.baseline.has(usage.turnId)) {
        const before = this.lastTotals ?? minus(usage.total, usage.last)
        if (before !== null) this.baseline.set(usage.turnId, before)
      }
      this.latest.set(usage.turnId, usage.total)
    }
    this.lastTotals = usage.total
  }

  private onTurnCompleted(params: Record<string, unknown>): void {
    if (!this.ownThread(params)) return
    const turn = asRecord(params.turn)
    const turnId = asString(turn.id)
    if (turnId === null) return
    this.bindTurn(turnId)
    this.seal(turnId)
    const end = turnEndOf(turn)
    this.attribute(turnId, {
      t: 'turn.ended',
      end: {
        turnKey: turnId,
        kind: end.kind,
        at: this.options.deps.clock.now(),
        reliability: 'reliable',
        cancelledFromApp: end.kind === 'interrupted' && this.interrupted.has(turnId),
        ...(end.detail === undefined ? {} : { detail: end.detail })
      }
    })
    // An ask of the turn the provider did not resolve is closed with it.
    for (const [id, ask] of this.asks) {
      if (ask.turnId !== turnId || ask.waiter !== null) continue
      this.asks.delete(id)
      this.emit({
        t: 'ask.resolved',
        providerRequestId: id,
        by: this.interrupted.has(turnId) ? 'cancelled' : 'elsewhere'
      })
    }
    this.openTurns.delete(turnId)
    const index = this.started.findIndex((entry) => entry.turnId === turnId)
    if (index !== -1) this.started.splice(index, 1)
    if (this.activeTurn === turnId) this.activeTurn = null
    if (this.foreign) {
      void this.confirmForeign(turnId).then(() => this.afterTurn())
      return
    }
    this.afterTurn()
  }

  /** The next queued message starts its own turn; with none left, the session is idle. */
  private afterTurn(): void {
    const next = this.queued.shift()
    if (next !== undefined && !this.closing && !this.outputEnded) {
      void this.startTurn(next.text, next.correlation).catch(() => undefined)
      return
    }
    if (this.started.length === 0 && this.activeTurn === null) this.becomeIdle()
  }

  private becomeIdle(): void {
    if (!this.working) return
    this.working = false
    this.emit({ t: 'status', value: 'idle' })
  }

  /** One sealed observation for the turn's unit, when it spent anything (ADR-006 items 4, 6). */
  private seal(turnId: string): void {
    const latest = this.latest.get(turnId)
    const before = this.baseline.get(turnId)
    this.latest.delete(turnId)
    this.baseline.delete(turnId)
    if (latest === undefined || before === undefined) return
    const spent = minus(latest, before)
    if (spent === null) return
    this.attribute(turnId, {
      t: 'usage',
      observation: {
        sourceKey: this.key(turnId),
        unitKey: turnId,
        fidelity: this.capabilities.usage.fidelity,
        tokens: unitTokens(spent),
        sealed: true,
        providerTime: null
      }
    })
  }

  // ---------- FM-085: a foreign server's turns ----------

  /** Reports a turn's facts now, or holds them until a foreign server's turn is confirmed. */
  private attribute(turnId: string | null, event: Attributable): void {
    if (!this.foreign || turnId === null) {
      this.emit(event)
      return
    }
    const held = this.held.get(turnId) ?? []
    held.push(event)
    this.held.set(turnId, held)
  }

  private async confirmForeign(turnId: string): Promise<void> {
    const held = this.held.get(turnId) ?? []
    this.held.delete(turnId)
    const check = this.options.deps.rolloutConfirms
    let confirmed = false
    try {
      confirmed =
        check !== undefined &&
        this.threadId !== null &&
        (await check({ threadId: this.threadId, rolloutPath: this.rolloutPath, turnId }))
    } catch {
      confirmed = false
    }
    if (confirmed) {
      for (const event of held) this.emit(event)
      return
    }
    this.reportOnce(`foreign:${turnId}`, {
      kind: 'provider-error',
      detail: 'a foreign Codex app-server ran the turn and its rollout did not confirm it',
      retryable: false
    })
  }

  // ---------- the end ----------

  /** The server's output ended: before an asked-for end, the transport is lost (C-18). */
  private outputEnd(): void {
    this.outputEnded = true
    for (const [id, ask] of this.asks) {
      this.asks.delete(id)
      ask.waiter?.({ kind: 'refused', reason: 'channel-unavailable' })
    }
    if (this.settleReady === null && !this.closing && !this.exited) {
      this.emit({
        t: 'error',
        cause: { kind: 'transport-lost', detail: 'the app-server output ended' }
      })
    }
    this.maybeExit()
  }

  private processExit(code: number | null): void {
    if (this.settleReady !== null) {
      this.settleReady(false, 'exited before readiness', null)
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
    this.channel.push({ t: 'exited', code: this.exitCode })
    this.channel.close()
    this.options.onExit(this.ref)
  }

  // ---------- helpers ----------

  /** 15 §4.4 Keys: `sourceKey = codex:codex:<threadId>:<itemId>`. */
  private key(eventId: string): string {
    return `${FAMILY}:${this.ref.providerId}:${this.ref.providerSessionId}:${eventId}`
  }

  /** HO-33: each distinct error is reported once per session. */
  private reportOnce(key: string, cause: DriverErrorCause): void {
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.emit({ t: 'error', cause })
  }

  private emit(event: DriverEvent): void {
    if (!this.exited) this.channel.push(event)
  }
}

// ---------- module helpers ----------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * FM-085 (L-07): Codex's user agent is `<originator>/<version> (…) (<client>; <version>)`, the
 * originator being the first client that initialized the server and the suffix the latest one
 * (codex@8f195c9 initialize_processor.rs `set_default_originator`, `USER_AGENT_SUFFIX`). A server
 * DwarfAI started on stdio names DwarfAI's client in both; a suffix naming DwarfAI under another
 * originator means another host started the server. A user agent whose suffix does not name
 * DwarfAI's client cannot tell, and is not evidence of a foreign server.
 */
export function startedByAnotherClient(userAgent: unknown, clientName: string): boolean {
  if (typeof userAgent !== 'string') return false
  const slash = userAgent.indexOf('/')
  const suffix = /\(([^();]+);[^()]*\)\s*$/.exec(userAgent)
  if (slash <= 0 || suffix?.[1]?.trim() !== clientName) return false
  return userAgent.slice(0, slash).trim() !== clientName
}

/** The Jev relay of a gated delegation launch (`ticket-file`, SP-12 partial); null otherwise. */
function jevOf(delegation: DelegationInjection | null, platform: Platform): JevRelay | null {
  if (
    delegation === null ||
    delegation.mechanism !== 'ticket-file' ||
    delegation.relay === undefined ||
    delegation.credentialFilePath === undefined
  ) {
    return null
  }
  return { relay: delegation.relay, credentialFilePath: delegation.credentialFilePath, platform }
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
