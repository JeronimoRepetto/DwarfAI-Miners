// ClaudeStreamJsonDriver (15 §4.2; ADR-009 D4): the Claude driver that needs only the person's own
// `claude`. It runs one persistent `claude -p --input-format stream-json --output-format stream-json
// --verbose` per session through the kernel `ProcessControl` (argv array, `shell: false` fixed in
// the adapter, process-group leader), with the `childEnv` allowlist (15 §4), the Host-assigned
// `--session-id`, DwarfAI's permission prompt tool and the question tool disallowed. The prompt and
// every turn go on stdin as stream-json user lines; stdout is read by `streamParser`.
//
// Gates (ISSUE-150; spike register): SP-08 pending → `probe()` answers `launch: false` whatever the
// help says, so the driver is built and conformance-tested but never offered; S-020-1 pending →
// readiness is the first `system` line and `earlyFailure` stays `exit-only`; SP-15 pending →
// `resume` stays `none` (resume() exists and is tested, but no caller is offered it). The
// permission prompt tool is served by the delegation relay (ADR-013 item 3): until that ask route
// exists and SP-08 passes, `permission` is `none` and no ask is ever opened here.
//
// No Agent SDK anywhere (OQ-52, R11), no provider credential read (ADR-008 item 2), no auto-approve
// flag (ADR-008 item 3: `buildArgv` refuses one). The driver never signals a process: ending one is
// ADR-014's `SessionTerminator` (`close('end-thread')` closes stdin, then the tree kill); the only
// process it ends is a `--help` probe that outlived PROBE_TIMEOUT_MS, by identity.
//
// Candidate decision (21 §6, TC-150-04): `src/main/sessionLaunch/heldSession.ts` and `heldCrew.ts`
// are replaced, not transplanted: both are written against the Agent SDK's held session (the
// `canUseTool` ask loop and the SDK `task_*` stream for subagents) and the legacy Dwarf/Feed
// types, neither of which exists on this transport; row C2 reports subagents from the transcript
// (`subagents: 'transcript'`), and the ended-task rule now lives in module observation's
// `EndedAgentLedger` (15 §5 item 2). `claudeTurnOutcome.ts` is adapted into `streamParser.ts`.
// Evidence: this driver's conformance run, and `heldCrew.test.ts:116,126` run unchanged on the
// legacy code (the PR hand-off records both).
import type { ProcessIdentity } from '../../../../../kernel/domain/processIdentity'
import type { AnswerOutcome } from '../../../../../kernel/domain/sharedContracts'
import type { Clock } from '../../../../../kernel/ports/clock'
import type { IdGenerator } from '../../../../../kernel/ports/idGenerator'
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
import { childEnv, type LoginEnvironment } from '../shared/childEnv'
import { relayEntry } from '../shared/relayEntry'
import { buildArgv } from './argv'
import { capabilitiesFromHelp, SPIKE_RECORDS } from './capabilities'
import { EventChannel } from './eventChannel'
import { mcpConfigPath, mcpConfigText, type McpConfigFiles } from './mcpConfigFile'
import {
  LineFramer,
  parseLine,
  tokensOf,
  toolSummary,
  turnEndOf,
  type StreamRecord
} from './streamParser'

/** 15 §0: the readiness bound of a launch or a resume. */
export const HANDSHAKE_TIMEOUT_MS = 30_000
/** ADR-020 D4: an exit before readiness inside this window is `exited-at-once`. */
export const EARLY_FAILURE_WINDOW_MS = 3_000
/** ADR-020 D1, D6: the output tail a launch failure carries, at most. */
const TAIL_CHARS = 400
/** The `model` Claude Code writes on a message it made up itself (not conversation). */
const SYNTHETIC_MODEL = '<synthetic>'
/** The assistant `error` Claude Code sets when it is not logged in (ADR-008 item 2). */
const NOT_LOGGED_IN = 'authentication_failed'
/** A `--help` probe reads at most this much. */
const HELP_READ_CHARS = 256 * 1024

export type Platform = 'win32' | 'darwin' | 'linux'

export interface ClaudeStreamJsonDriverDeps {
  /** The Claude catalog record: profile, ceiling and documented variables (`profiles.ts`). */
  readonly record: CatalogRecord
  /** The one install detection behind every `detect()` (ADR-009 D5). */
  readonly detection: InstallDetection
  readonly processControl: ProcessControl
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** Mints the `--session-id` the Host pre-assigns and each first-prompt line's uuid. */
  readonly ids: IdGenerator
  /** The person's login environment `childEnv` copies named variables from (15 §4). */
  readonly loginEnv: LoginEnvironment
  /** The folder a `--help` probe runs in (the person's home). */
  readonly home: string
  readonly platform: Platform
  /** `<hostDataDir>/run/mcp` and its owner-only file store (ADR-013 item 3). */
  readonly mcpConfig: { readonly dir: string; readonly files: McpConfigFiles }
  /** One-line redaction of activity summaries (`contracts/logging` `redactSecrets`, bound by wiring). */
  readonly redact: (text: string) => string
}

/** What a resume needs that `SessionRef` does not carry (package gap, recorded in the hand-off). */
interface Remembered {
  readonly cwd: string
  readonly spawnTag: string
}

export class ClaudeStreamJsonDriver implements ProviderDriver {
  readonly profile: ProviderProfile
  readonly transport = 'stream-json' as const
  private readonly launchIds = new Set<string>()
  /** Session ids whose process this Host holds now (ADR-015: never two writers). */
  private readonly live = new Set<string>()
  private readonly remembered = new Map<string, Remembered>()
  /** The last probe per install (binary, version, mtime): the session's probe source (15 §2.1). */
  private readonly probed = new Map<string, ProviderCapabilities>()

  constructor(private readonly deps: ClaudeStreamJsonDriverDeps) {
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
    const caps = merge(this.deps.record.ceiling, capabilitiesFromHelp(help, SPIKE_RECORDS))
    this.probed.set(installKey(install), caps)
    return structuredClone(caps)
  }

  async launch(req: DriverLaunchRequest): Promise<DriverSession> {
    if (this.launchIds.has(req.launchId)) {
      throw launchError('could-not-start', 'launch id already used')
    }
    this.launchIds.add(req.launchId)
    const sessionId = this.deps.ids.uuidv7()
    const config = await this.writeMcpConfig(req)
    let argv: string[]
    try {
      argv = buildArgv({
        kind: 'launch',
        sessionId,
        ...(req.model === undefined ? {} : { model: req.model }),
        ...(req.effort === undefined ? {} : { effort: req.effort }),
        mcpConfigPath: config.path,
        policyArgv: req.permissionMode?.providerArgs.argv ?? []
      })
    } catch {
      await config.remove()
      throw launchError('could-not-start', 'the argv was refused (ADR-008 item 3)')
    }
    const spawnedAt = this.deps.clock.now()
    const child = this.spawn(req.install.binaryPath, argv, req.cwd, req.spawnTag)
    let identity: ProcessIdentity
    try {
      identity = await child.identity
    } catch (error) {
      await config.remove()
      throw spawnFailure(error)
    }
    await req.onSpawned(identity)
    const session = new StreamJsonSession({
      child,
      ref: {
        providerId: this.profile.id,
        providerSessionId: sessionId,
        pid: identity.pid,
        processStartTimeMs: identity.processStartTimeMs
      },
      capabilities: this.sessionCapabilities(req.install),
      mode: 'launch',
      spawnedAt,
      deps: this.deps,
      fail: (early, detail, tail) =>
        launchError(early ? 'exited-at-once' : 'could-not-start', detail, tail),
      onExit: (ref) => {
        this.live.delete(ref.providerSessionId)
        void config.remove()
      }
    })
    this.live.add(sessionId)
    this.remembered.set(sessionId, { cwd: req.cwd, spawnTag: req.spawnTag })
    session.writePrompt(req.prompt, this.deps.ids.uuidv7())
    try {
      return await session.ready
    } catch (error) {
      this.live.delete(sessionId)
      await config.remove()
      throw error
    }
  }

  async resume(ref: SessionRef): Promise<DriverSession> {
    if (this.live.has(ref.providerSessionId)) {
      throw resumeError('resume-error', 'the session is live in this Host')
    }
    const known = this.remembered.get(ref.providerSessionId)
    if (known === undefined) {
      throw resumeError('resume-error', 'the folder and spawn tag of the session are unknown')
    }
    const detected = await this.detect()
    if (detected.kind !== 'installed') throw launchError('not-installed', 'claude is not installed')
    const argv = buildArgv({
      kind: 'resume',
      sessionId: ref.providerSessionId,
      mcpConfigPath: null,
      policyArgv: []
    })
    const spawnedAt = this.deps.clock.now()
    const child = this.spawn(detected.install.binaryPath, argv, known.cwd, known.spawnTag)
    let identity: ProcessIdentity
    try {
      identity = await child.identity
    } catch (error) {
      const failure = spawnFailure(error)
      if (failure.cause === 'not-installed') throw failure
      throw resumeError('resume-error', failure.detail)
    }
    const session = new StreamJsonSession({
      child,
      ref: {
        providerId: this.profile.id,
        providerSessionId: ref.providerSessionId,
        pid: identity.pid,
        processStartTimeMs: identity.processStartTimeMs
      },
      capabilities: this.sessionCapabilities(detected.install),
      mode: 'resume',
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

  /** 15 §2.1: the ceiling merged with the protocol (nothing yet, S-020-1) and the probe source. */
  private sessionCapabilities(install: InstalledProvider): ProviderCapabilities {
    const probe =
      this.probed.get(installKey(install)) ??
      merge(this.deps.record.ceiling, capabilitiesFromHelp(null, SPIKE_RECORDS))
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
      // The relay is a stdio MCP server claude starts itself, never a loopback HTTP endpoint.
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

  /** ADR-013 item 3 `ticket-file`: the relay entry with the credential-file path, before the spawn. */
  private async writeMcpConfig(
    req: DriverLaunchRequest
  ): Promise<{ path: string | null; remove: () => Promise<void> }> {
    const delegation = req.delegation
    if (
      delegation === null ||
      delegation.mechanism !== 'ticket-file' ||
      delegation.relay === undefined ||
      delegation.credentialFilePath === undefined
    ) {
      return { path: null, remove: async () => {} }
    }
    const { dir, files } = this.deps.mcpConfig
    const path = mcpConfigPath(dir, req.launchId, this.deps.platform)
    try {
      const entry = relayEntry({
        command: delegation.relay.program,
        args: delegation.relay.args,
        credentialFilePath: delegation.credentialFilePath,
        platform: this.deps.platform
      })
      await files.write(path, mcpConfigText(entry))
    } catch {
      throw launchError('could-not-start', 'the --mcp-config file could not be written')
    }
    let removed = false
    return {
      path,
      remove: async () => {
        if (removed) return
        removed = true
        await files.remove(path).catch(() => undefined)
      }
    }
  }

  /**
   * `claude --help` with an argv array and the probe environment, bounded by PROBE_TIMEOUT_MS; a
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
  readonly ref: SessionRef
  readonly capabilities: ProviderCapabilities
  /** `launch`: the id is the Host's; `resume`: the first system line names the id it continues. */
  readonly mode: 'launch' | 'resume'
  readonly spawnedAt: number
  readonly deps: ClaudeStreamJsonDriverDeps
  /** The rejection of a handshake that failed (`early`: exit inside the 3 s window). */
  readonly fail: (early: boolean, detail: string, tail: string) => unknown
  readonly onExit: (ref: SessionRef) => void
}

interface OpenUnit {
  readonly id: string
  readonly tokens: ReturnType<typeof tokensOf>
}

class StreamJsonSession implements DriverSession {
  ref: SessionRef
  readonly capabilities: ProviderCapabilities
  /** Resolves at the first `system` line (readiness, UNVERIFIED until S-020-1). */
  readonly ready: Promise<DriverSession>
  private readonly channel = new EventChannel<DriverEvent>()
  private readonly framer = new LineFramer()
  private settleReady: ((ok: boolean, detail: string) => void) | null = null
  private readonly handshakeTimer: { cancel(): void }
  private stderrTail = ''
  private openTurns = 0
  private results = 0
  private openUnit: OpenUnit | null = null
  private readonly tools = new Map<string, { toolName: string; summary: string }>()
  private readonly reported = new Set<string>()
  private closing = false
  private outputEnded = false
  private exitSeen = false
  private exitCode: number | null = null
  private exited = false

  constructor(private readonly options: SessionOptions) {
    this.ref = { ...options.ref }
    this.capabilities = structuredClone(options.capabilities)
    const { child, deps } = options
    this.ready = new Promise<DriverSession>((resolve, reject) => {
      this.settleReady = (ok, detail) => {
        this.settleReady = null
        this.handshakeTimer.cancel()
        if (ok) resolve(this)
        else {
          const early = deps.clock.now() - options.spawnedAt < EARLY_FAILURE_WINDOW_MS
          reject(options.fail(early && detail !== 'handshake timeout', detail, this.tail()))
        }
      }
    })
    this.handshakeTimer = deps.scheduler.after(HANDSHAKE_TIMEOUT_MS, () => {
      // 15 §1.3: on a handshake timeout the driver closes its transport and rejects.
      this.closeInput()
      this.settleReady?.(false, 'handshake timeout')
    })
    child.stderr?.setEncoding('utf8')
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

  /** The launch's first turn: its user line, with a uuid the Host minted. */
  writePrompt(text: string, uuid: string): void {
    this.writeUser(text, uuid, null)
  }

  async sendTurn(input: TurnInput): Promise<SendReceipt> {
    if (this.exited || this.closing) {
      throw sendError('session-closed', 'the session has ended')
    }
    if (input.attachments.length > 0) {
      throw sendError('channel-error', 'this driver does not send attachments yet')
    }
    const held = this.writeUser(input.text, input.messageId, input.messageId)
    // No stream-json acknowledgement of a user line exists (S-022-1): written, not confirmed.
    return { confidence: 'unconfirmed', heldUntilTurnEnd: held, correlation: input.messageId }
  }

  /** `interrupt` is false on this driver (15 §3 row C2): the caller goes to ADR-014's kill. */
  async interrupt(): Promise<void> {}

  /** No ask is ever opened here (`permission: 'none'` until SP-08): every id is closed. */
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

  /** Writes one user line; returns whether it queues behind a running turn. */
  private writeUser(text: string, uuid: string, echoOf: string | null): boolean {
    const held = this.openTurns > 0
    if (!held) this.emit({ t: 'status', value: 'working' })
    this.openTurns += 1
    this.emit({
      t: 'message',
      record: {
        sourceKey: this.key(uuid),
        role: 'person',
        text,
        providerTime: null,
        ...(echoOf === null ? {} : { echoOf })
      }
    })
    const line = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.ref.providerSessionId,
      uuid
    }
    this.options.child.stdin?.write(`${JSON.stringify(line)}\n`)
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
      case 'system':
        this.onSystem(record.sessionId)
        return
      case 'assistant':
        this.onAssistant(record)
        return
      case 'user':
        if (record.parentToolUseId !== null) return // a subagent's own tool result
        for (const result of record.toolResults) this.finishTool(result.toolUseId, result.isError)
        return
      case 'result':
        this.onResult(record.uuid, record.subtype)
        return
      case 'rate-limit':
        if (record.status === 'rejected') {
          const resetAt = record.resetsAt === null ? undefined : record.resetsAt * 1000
          this.reportOnce(`rate-limited:${String(resetAt)}`, {
            kind: 'rate-limited',
            ...(resetAt === undefined ? {} : { resetAt })
          })
        }
        return
      case 'drift':
        this.reportOnce(`drift:${record.detail}`, { kind: 'protocol-drift', detail: record.detail })
        return
      case 'ignored':
        return
    }
  }

  private onSystem(sessionId: string | null): void {
    if (this.settleReady === null) return
    if (this.options.mode === 'resume' && sessionId !== null) {
      const previous = this.ref.providerSessionId
      if (sessionId !== previous) {
        // ADR-015 item 7: a resume that minted a new id names the one it continues.
        this.ref = {
          ...this.ref,
          providerSessionId: sessionId,
          previousProviderSessionId: previous
        }
      }
    }
    this.settleReady(true, 'ready')
  }

  private onAssistant(record: Extract<StreamRecord, { kind: 'assistant' }>): void {
    // A subagent's line (ADR-009 D7): the transcript path owns subagents (row C2 `transcript`).
    if (record.parentToolUseId !== null) return
    if (record.error === NOT_LOGGED_IN) this.reportOnce('auth-required', { kind: 'auth-required' })
    if (record.model === SYNTHETIC_MODEL) return // Claude Code's own line, not conversation
    const { messageId } = record
    if (messageId !== null && record.usage !== null) {
      if (this.openUnit !== null && this.openUnit.id !== messageId) this.seal()
      this.openUnit = { id: messageId, tokens: tokensOf(record.usage) }
    }
    const text = record.blocks
      .flatMap((block) => (block.type === 'text' && block.text !== '' ? [block.text] : []))
      .join('\n')
    if (text !== '') {
      this.emit({
        t: 'message',
        record: {
          sourceKey: this.key(record.uuid ?? `${messageId ?? 'message'}:text`),
          role: 'dwarf',
          text,
          providerTime: null
        }
      })
    }
    for (const block of record.blocks) {
      if (block.type !== 'tool_use') continue
      const step = {
        toolName: block.name,
        summary: toolSummary(block.name, block.input, this.options.deps.redact)
      }
      this.tools.set(block.id, step)
      this.emitTool(block.id, step, 'started')
    }
    // ADR-006 item 6: the row with a stop_reason is the unit's final one.
    if (record.stopReason !== null && this.openUnit?.id === messageId) this.seal()
  }

  private finishTool(toolUseId: string, isError: boolean): void {
    const step = this.tools.get(toolUseId)
    if (step === undefined) return
    this.tools.delete(toolUseId)
    this.emitTool(toolUseId, step, isError ? 'failed' : 'finished')
  }

  private emitTool(
    id: string,
    step: { toolName: string; summary: string },
    state: 'started' | 'finished' | 'failed'
  ): void {
    this.emit({
      t: 'activity',
      step: {
        sourceKey: this.key(id),
        turnKey: null,
        kind: 'tool',
        toolName: step.toolName,
        summary: step.summary,
        state,
        at: null
      }
    })
  }

  private onResult(uuid: string | null, subtype: string): void {
    this.seal()
    this.results += 1
    const end = turnEndOf(subtype)
    this.emit({
      t: 'turn.ended',
      end: {
        turnKey: this.key(uuid ?? `result-${this.results}`),
        kind: end.kind,
        at: this.options.deps.clock.now(),
        reliability: 'reliable',
        cancelledFromApp: false,
        ...(end.detail === undefined ? {} : { detail: end.detail })
      }
    })
    this.openTurns = Math.max(0, this.openTurns - 1)
    if (this.openTurns === 0) this.emit({ t: 'status', value: 'idle' })
  }

  /** One sealed usage observation for the open unit (ADR-006 items 4 and 6). */
  private seal(): void {
    const unit = this.openUnit
    if (unit === null) return
    this.openUnit = null
    this.emit({
      t: 'usage',
      observation: {
        sourceKey: this.key(unit.id),
        unitKey: unit.id,
        fidelity: this.capabilities.usage.fidelity,
        tokens: unit.tokens,
        sealed: true,
        providerTime: null
      }
    })
  }

  // ---------- the end ----------

  /** stdout ended: before an asked-for end, the transport is lost (15 §1.3 `events()`, C-18). */
  private outputEnd(): void {
    const last = this.framer.flush()
    if (last !== null) this.handle(parseLine(last))
    this.outputEnded = true
    if (this.settleReady === null && !this.closing && !this.exited) {
      this.emit({ t: 'error', cause: { kind: 'transport-lost', detail: 'claude output ended' } })
    }
    this.maybeExit()
  }

  private processExit(code: number | null): void {
    if (this.settleReady !== null) {
      this.settleReady(false, 'exited before readiness')
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
    this.tools.clear()
    this.channel.push({ t: 'exited', code: this.exitCode })
    this.channel.close()
    this.options.onExit(this.ref)
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
