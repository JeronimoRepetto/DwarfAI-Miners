// HostedCommandDriver (15 §4.11, `stdio-raw`, "Other…"; 15 §3 row H1): runs the person's own
// command as an owned session. The argv `parseHostedCommand()` produced (launching's, later:
// ISSUE-165) is spawned as an array through the kernel `ProcessControl.spawn`, never through a
// shell (`18` C-17, NFR-SEC-09, R17; `shell: false` is fixed in the adapter, AMENDMENT-10), with
// the allowlisted child environment (15 §4 `childEnv`, INV-59). The first prompt and every
// composer text go to its stdin with a newline; its stdout and stderr come back as entries for
// the dwarf's read-only `log` console (`outputTail.ts`, ADR-031 items 1–2). It has no handshake:
// launch() resolves once the 3 s early-failure window passed with no exit (`earlyFailure:
// 'exit-only'`, ADR-020 D4). It has no ask, no usage, no resume, no interrupt and no protocol
// close: it ends only by ADR-014's identity-checked tree kill, which is never the driver's.
//
// A raw program reports no turn end (`turnEnd: 'none'`), so the driver declares the inference
// (ADR-032 D5, ADR-021 item 1): a turn opens when DwarfAI writes to stdin and ends `inferred`
// after `INFERRED_TURN_END_MS` with no new output; an inferred end never fires a finished cue.
//
// Candidate decision (21 §6): `src/main/sessionLaunch/hostedProcesses.ts`, `nodeHostedProcess.ts`,
// `hostedBoard.ts` and `oneShotTurnOutcome.ts` are replaced, not kept or adapted. Their tests pass
// unchanged at their own seam, but they are a panel-level registry and a board stamp, not a
// ProviderDriver: they spawn through `node:child_process` (R17), take the whole inherited
// environment, kill by a bare pid, write the person's text to stdin without an echo correlation,
// and have no early-failure window, no sourceKeys and no event stream, so they cannot run the
// 15 §6 suite. The design kept: argv and prompt split (prompt on stdin, never argv), stdin text
// kept only once the pipe took it, output captured as plain text with no TUI parsing.
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import type { ProcessIdentity } from '../../../../../kernel/domain/processIdentity'
import type { AnswerOutcome } from '../../../../../kernel/domain/sharedContracts'
import type { Clock } from '../../../../../kernel/ports/clock'
import type { ProcessControl, SpawnedProcess } from '../../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../../kernel/ports/scheduler'
import type { ProviderCapabilities } from '../../../domain/capabilities'
import type {
  CloseOutcome,
  DetectResult,
  DriverEvent,
  DriverLaunchError,
  DriverLaunchRequest,
  DriverSendError,
  DriverSession,
  ProviderDriver,
  SendReceipt,
  SessionRef,
  TurnInput
} from '../../../ports/providerDriver'
import { childEnv, type LoginEnvironment } from '../shared/childEnv'
import { assertNoForbidden } from '../shared/forbiddenFlags'
import { entryKey, logEntry, OutputTail, type OutputLine } from './outputTail'
import { HOSTED_COMMAND_CEILING, HOSTED_COMMAND_PROFILE } from './profile'

/** 15 §0 / ADR-020 D4: an exit before `t0 + 3 s` is `exited-at-once`; at 3 s the launch succeeded. */
export const EARLY_FAILURE_WINDOW_MS = 3_000
/** ADR-032 D5's default: no new output for this long and the turn's end is inferred. */
export const INFERRED_TURN_END_MS = 30_000
/**
 * After the exit, how long the driver waits for the program's stdout to drain before it reports
 * `exited` anyway (a grandchild may hold the pipe open). An adapter choice, within ADR-014's 2 s.
 */
export const OUTPUT_DRAIN_MS = 2_000
/** ADR-020 D1, D6: the output tail a launch failure carries, at most. */
const TAIL_CHARS = 400

/** A character no argv element may hold: it never comes from `parseHostedCommand` (NUL, CR, LF). */
const FORBIDDEN_ARG_CHARACTERS = /[\u0000\r\n]/

export interface HostedCommandDriverOptions {
  readonly processControl: ProcessControl
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** The person's login environment `childEnv` copies the named variables from (15 §4). */
  readonly loginEnv: LoginEnvironment
  readonly platform: NodeJS.Platform
  /** The one redaction rule (`contracts/logging` `redactSecrets`), bound by wiring (05 R9). */
  readonly redact: (text: string) => string
}

function refused(detail: string): DriverLaunchError {
  return { cause: 'could-not-start', detail }
}

export class HostedCommandDriver implements ProviderDriver {
  readonly profile = HOSTED_COMMAND_PROFILE
  readonly transport = 'stdio-raw' as const
  /** 15 §1.3 launch: one call per launchId. */
  private readonly launched = new Set<string>()

  constructor(private readonly options: HostedCommandDriverOptions) {}

  /** `installDetection: 'none'`: "Other…" has no CLI of its own to resolve (15 §3 H1). */
  async detect(): Promise<DetectResult> {
    return { kind: 'not-installed' }
  }

  /** Nothing to negotiate and nothing to run: the H1 ceiling, with no process started. */
  async probe(): Promise<ProviderCapabilities> {
    return HOSTED_COMMAND_CEILING
  }

  async launch(req: DriverLaunchRequest): Promise<DriverSession> {
    const argv = this.validated(req)
    this.launched.add(req.launchId)
    let env: Record<string, string>
    try {
      env = childEnv(this.options.loginEnv, req.spawnTag, {
        providerVars: [],
        loopbackRelay: false,
        platform: this.options.platform
      })
    } catch (error) {
      if (error instanceof HostInvariantError) throw refused(error.message)
      throw error
    }
    const { clock, processControl } = this.options
    const spawnedAt = clock.now()
    const child = processControl.spawn({
      executable: argv[0] as string,
      args: argv.slice(1),
      cwd: req.cwd,
      env,
      processGroup: 'own',
      stdio: 'pipe'
    })
    const session = new HostedCommandSession(child, req.launchId, this.options, spawnedAt)
    let identity: ProcessIdentity
    try {
      identity = await child.identity
    } catch (error) {
      const code = (error as { code?: string }).code
      // 15 §1.3: ENOENT is not-installed; every other spawn refusal is could-not-start.
      const failure: DriverLaunchError =
        code === 'ENOENT'
          ? { cause: 'not-installed', detail: 'spawn ENOENT' }
          : refused(`spawn ${code ?? 'failed'}`)
      throw failure
    }
    try {
      await req.onSpawned(identity)
    } catch {
      throw refused('the spawned process could not be recorded')
    }
    session.bind(identity)
    session.writePrompt(req.prompt)
    return session.ready()
  }

  /** The person's argv, or a could-not-start refusal before any spawn (ADR-020 item 3). */
  private validated(req: DriverLaunchRequest): readonly string[] {
    if (this.launched.has(req.launchId)) throw refused('this launch id was already launched')
    if (req.permissionMode !== null) throw refused('stdio-raw launches with no permission mode')
    if (req.delegation !== null) throw refused('stdio-raw never carries a delegation injection')
    const argv = req.customArgv
    if (argv === undefined || argv.length === 0) throw refused('no parsed command to run')
    if (argv.some((arg) => typeof arg !== 'string' || FORBIDDEN_ARG_CHARACTERS.test(arg))) {
      throw refused('an argument holds a NUL or a line break')
    }
    const program = argv[0] as string
    if (program === '') throw refused('the command names no program')
    // ADR-008 item 1: the install is the only executable the driver may spawn.
    if (program !== req.install.binaryPath) throw refused('the program is not the launch install')
    try {
      // ADR-008 item 3: no auto-approve flag reaches a child, the person's own command included.
      assertNoForbidden(argv, undefined, {
        delegationGate: { subagentDelegationOn: false, launchedWithLetJevChoose: false }
      })
    } catch (error) {
      if (error instanceof HostInvariantError) throw refused(error.message)
      throw error
    }
    return argv
  }
}

type Readiness = {
  resolve: (session: DriverSession) => void
  reject: (failure: DriverLaunchError) => void
}

class HostedCommandSession implements DriverSession {
  ref: SessionRef
  readonly capabilities = HOSTED_COMMAND_CEILING
  private readonly channel = new EventChannel<DriverEvent>()
  private readonly stdout = new OutputTail('stdout')
  private readonly stderr = new OutputTail('stderr')
  private readonly streamId: string
  /** The last characters the program wrote, for a launch failure's tail (memory only). */
  private captured = ''
  /** Bytes written to stdin so far: the offset of the next write. */
  private stdinOffset = 0
  /** Lines that arrived while a stdin write was in flight; they belong to the turn it opens. */
  private held: OutputLine[] | null = null
  private turn: { key: string; timer: { cancel(): void } } | null = null
  private readiness: Readiness | null = null
  private readyTimer: { cancel(): void } | null = null
  private stdinBroken = false
  private outputEnded = false
  private exitCode: number | null | undefined = undefined
  private drainTimer: { cancel(): void } | null = null
  private exited = false

  constructor(
    private readonly child: SpawnedProcess,
    launchId: string,
    private readonly options: HostedCommandDriverOptions,
    private readonly spawnedAt: number
  ) {
    this.ref = { providerId: HOSTED_COMMAND_PROFILE.id, providerSessionId: launchId }
    this.streamId = `${HOSTED_COMMAND_PROFILE.id}:${launchId}`
    // Listening from the spawn on: output written before readiness is buffered, never dropped.
    child.stdout?.on('data', (chunk: Buffer | string) => this.read(this.stdout, chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => this.read(this.stderr, chunk))
    child.stdout?.on('end', () => this.outputEnd())
    child.stdin?.on('error', () => {
      this.stdinBroken = true
    })
    child.exited.then(
      (outcome) => this.processExit(outcome.code),
      () => {}
    )
  }

  /** The root's identity, once known (ADR-014 item 1). */
  bind(identity: ProcessIdentity): void {
    this.ref = { ...this.ref, pid: identity.pid, processStartTimeMs: identity.processStartTimeMs }
  }

  /** The first turn: the prompt on stdin, never in argv (15 §1.2). */
  writePrompt(prompt: string): void {
    if (prompt === '') return
    void this.write(prompt).then(
      (offset) => this.opened(offset),
      () => this.release()
    )
  }

  /** Resolves at `t0 + 3 s` with no exit; an exit before then is `exited-at-once` (ADR-020 D4). */
  ready(): Promise<DriverSession> {
    return new Promise<DriverSession>((resolve, reject) => {
      this.readiness = { resolve, reject }
      if (this.exitCode !== undefined) {
        this.settleOnExit(this.exitCode)
        return
      }
      const { clock, scheduler } = this.options
      const left = this.spawnedAt + EARLY_FAILURE_WINDOW_MS - clock.now()
      this.readyTimer = scheduler.after(left, () => this.becomeReady())
    })
  }

  events(): AsyncIterable<DriverEvent> {
    return this.channel
  }

  async sendTurn(input: TurnInput): Promise<SendReceipt> {
    if (this.exited) {
      const closed: DriverSendError = { kind: 'session-closed', reason: 'the command has exited' }
      throw closed
    }
    const offset = await this.write(input.text).catch(() => {
      this.release()
      const failure: DriverSendError = {
        kind: 'channel-error',
        reason: "the command's stdin refused the text"
      }
      throw failure
    })
    const correlation = `${this.ref.providerSessionId}:${input.messageId}`
    this.opened(offset, {
      t: 'message',
      record: {
        sourceKey: entryKey(this.streamId, 'stdin', offset),
        role: 'person',
        text: input.text,
        providerTime: null,
        echoOf: correlation
      }
    })
    return { confidence: 'confirmed', heldUntilTurnEnd: false, correlation }
  }

  /** `interrupt: false` (15 §3 H1): kill only, so the caller goes to ADR-014's tree kill. */
  async interrupt(): Promise<void> {}

  async answerPermission(): Promise<AnswerOutcome> {
    return { kind: 'refused', reason: 'ask-closed' }
  }

  async answerQuestion(): Promise<AnswerOutcome> {
    return { kind: 'refused', reason: 'ask-closed' }
  }

  /** A raw program has no protocol close: kill only (15 §4.11, §1.3 close). Nothing is signalled. */
  async close(): Promise<CloseOutcome> {
    return { kind: 'failed', reason: 'unsupported' }
  }

  // ---------- stdin ----------

  /**
   * Writes `text` and a newline; resolves the offset it was written at once the pipe took it.
   * Output that arrives meanwhile is held, so it follows the turn's start and the echo.
   */
  private write(text: string): Promise<number> {
    const stdin = this.child.stdin
    if (stdin === null || this.stdinBroken || stdin.destroyed || stdin.writableEnded) {
      return Promise.reject(new Error('stdin is closed'))
    }
    const line = `${text}\n`
    const offset = this.stdinOffset
    this.stdinOffset += Buffer.byteLength(line, 'utf8')
    this.held ??= []
    return new Promise((resolve, reject) => {
      stdin.write(line, (error) => (error ? reject(error) : resolve(offset)))
    })
  }

  /** The write at `offset` was taken: the turn opens (or goes on), its echo, then held output. */
  private opened(offset: number, echo?: DriverEvent): void {
    if (this.turn === null) {
      const key = entryKey(this.streamId, 'stdin', offset)
      this.turn = { key, timer: this.quietTimer() }
      this.emit({ t: 'status', value: 'working' })
    } else this.restartQuiet()
    if (echo !== undefined) this.emit(echo)
    this.release()
  }

  private release(): void {
    const held = this.held ?? []
    this.held = null
    for (const line of held) this.entry(line)
  }

  // ---------- output ----------

  private read(tail: OutputTail, chunk: Buffer | string): void {
    this.captured = (this.captured + chunk.toString()).slice(-TAIL_CHARS)
    for (const line of tail.push(chunk)) {
      if (this.held !== null) this.held.push(line)
      else this.entry(line)
    }
  }

  private entry(line: OutputLine, restart = true): void {
    const { clock } = this.options
    this.emit(
      logEntry(line, {
        streamId: this.streamId,
        turnKey: this.turn?.key ?? null,
        at: clock.now(),
        redact: this.options.redact
      })
    )
    if (restart) this.restartQuiet()
  }

  private flushOutput(): void {
    this.release()
    for (const line of [...this.stdout.flush(), ...this.stderr.flush()]) this.entry(line, false)
  }

  // ---------- inferred turn end (ADR-032 D5) ----------

  private quietTimer(): { cancel(): void } {
    return this.options.scheduler.after(INFERRED_TURN_END_MS, () => this.endTurn())
  }

  private restartQuiet(): void {
    if (this.turn === null) return
    this.turn.timer.cancel()
    this.turn.timer = this.quietTimer()
  }

  private endTurn(): void {
    const turn = this.turn
    if (turn === null || this.exited) return
    // The quiet output's unterminated last line (a prompt waiting for an answer) is shown now.
    this.flushOutput()
    this.turn = null
    this.emit({
      t: 'turn.ended',
      end: {
        turnKey: turn.key,
        kind: 'concluded',
        at: this.options.clock.now(),
        reliability: 'inferred',
        cancelledFromApp: false
      }
    })
    this.emit({ t: 'status', value: 'idle' })
  }

  // ---------- readiness and the end ----------

  private becomeReady(): void {
    const readiness = this.readiness
    this.readiness = null
    this.readyTimer = null
    readiness?.resolve(this)
  }

  /** The exit settles a pending launch: before 3 s `exited-at-once`, from 3 s on a success. */
  private settleOnExit(code: number | null): void {
    const readiness = this.readiness
    if (readiness === null) return
    const elapsed = this.options.clock.now() - this.spawnedAt
    if (elapsed >= EARLY_FAILURE_WINDOW_MS) {
      this.readyTimer?.cancel()
      this.becomeReady()
      return
    }
    this.readyTimer?.cancel()
    this.readiness = null
    this.cancelTurn()
    const tail = this.captured
    readiness.reject({
      cause: 'exited-at-once',
      detail: `exited with code ${String(code)} before the 3 s early-failure window ended`,
      ...(tail === '' ? {} : { toolOutputTail: tail })
    })
  }

  /** CH-04: stdout reached EOF before the exit was reported: the transport is lost (15 §1.2). */
  private outputEnd(): void {
    if (this.outputEnded) return
    this.outputEnded = true
    if (this.exited) return
    this.flushOutput()
    this.emit({
      t: 'error',
      cause: { kind: 'transport-lost', detail: 'the command closed its output' }
    })
    this.maybeExit()
  }

  private processExit(code: number | null): void {
    if (this.exitCode !== undefined) return
    this.exitCode = code
    this.settleOnExit(code)
    if (!this.outputEnded && !this.exited) {
      this.drainTimer = this.options.scheduler.after(OUTPUT_DRAIN_MS, () => this.exit())
    }
    this.maybeExit()
  }

  private maybeExit(): void {
    if (this.outputEnded && this.exitCode !== undefined) this.exit()
  }

  /** `exited` is the last event, exactly once (15 §1.4). */
  private exit(): void {
    if (this.exited || this.readiness !== null) return
    this.flushOutput()
    this.cancelTurn()
    this.drainTimer?.cancel()
    this.exited = true
    this.channel.push({ t: 'exited', code: this.exitCode ?? null })
    this.channel.close()
  }

  private cancelTurn(): void {
    this.turn?.timer.cancel()
    this.turn = null
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
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false })
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      }
    }
  }
}
