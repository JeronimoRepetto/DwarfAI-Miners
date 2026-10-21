// ClaudeStreamJsonDriver (15 §4.2; ADR-009 D4): the Claude driver that needs only the person's own
// `claude`. It runs one persistent `claude -p --input-format stream-json --output-format stream-json
// --verbose` per session through the kernel `ProcessControl` (argv array, `shell: false` fixed in
// the adapter, process-group leader), with the `childEnv` allowlist (15 §4), the Host-assigned
// `--session-id`, DwarfAI's permission prompt tool and the question tool disallowed. The prompt and
// every turn go on stdin as stream-json user lines; stdout is read by `streamParser`.
//
// Gates (ISSUE-150; ISSUE-321 records for Claude Code 2.1.301, Windows): SP-08 passed → `probe()`
// opens `launch` when the help advertises the prompt tool (as its own option or, as in 2.1.301,
// inside the `--permission-prompts` description). S-020-1 passed → readiness is `system/init`,
// which the CLI writes only after the first stdin line, so a launch writes its prompt first and a
// SessionStart hook line is never readiness; an error `result` before `system/init` is the launch
// failing (`earlyFailure: 'handshake'`). SP-15 passed → `--resume <id>` keeps the id; a resume
// writes nothing, so it is ready at `system/init` or once the 3 s early-failure window passed
// without an error `result` or an exit.
//
// The permission prompt tool (AMENDMENT-21, owner-approved 2026-10-17): the Host's MCP endpoint
// serves `mcp__dwarfai__permission` on the relay entry (ADR-013 item 3), so every launch carries
// the `--mcp-config` file: the gated request's own `DelegationInjection`, else the entry
// `PromptToolRelay.issue` gives (a launch that cannot get one fails `could-not-start`); a resume
// writes the same entry again in a file of its own. Before the spawn the launch registers its
// session under its launch id (`PromptToolSessions`): each prompt-tool call of that relay opens
// one `ask.opened` (channel `driver`, id = the tool use id, Allow and Deny both offered) and
// settles with the first `answerPermission` for it (ADR-010: Allow/Deny only, first answer wins,
// a stale answer is `ask-closed` and reaches nothing). A cancelled call resolves its ask
// `cancelled`; a session that ends denies every call still open (fail closed, 15 §2.7). Only the
// two delegation tools are ever pre-approved, and only on a gated launch (ISSUE-201).
//
// Attachments (#1463; 15 §1.2 `TurnInput.attachments`, US-MSG-002.AC03): each Host-revalidated path
// is named on its own `Attached file: <path>` line ahead of the words of the user line
// (`userContentOf`), and claude opens it with its own tools. Only paths travel, on stdin; the echo
// DwarfAI records is the person's words alone.
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
import type { LaunchId } from '../../../../../kernel/domain/values'
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
  DelegationInjection,
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
import { relayEntry } from '../shared/relayEntry'
import { buildArgv } from './argv'
import { capabilitiesFromHelp, SPIKE_RECORDS } from './capabilities'
import { EventChannel } from './eventChannel'
import { mcpConfigPath, mcpConfigText, type McpConfigFiles } from './mcpConfigFile'
import type { PromptToolCall, PromptToolDeps } from './promptTool'
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
/** The program that runs a Windows npm install's script entry (ADR-029 row 8, #1360). */
const NODE_BINARY = 'node'
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
  /** The permission prompt tool's relay entry and session registry (AMENDMENT-21). */
  readonly promptTool: PromptToolDeps
  /** One-line redaction of activity summaries (`contracts/logging` `redactSecrets`, bound by wiring). */
  readonly redact: (text: string) => string
  /**
   * What a resume needs that `SessionRef` does not carry, read from the stored launch record when
   * this driver instance did not launch the session (a restarted Host, ISSUE-173): its folder and
   * the spawn tag of the resumed process. Bound by host/wiring (bridges/resumeContext.ts); the
   * driver never imports launching (R3, R4). Absent, or null: the session is unknown here.
   */
  readonly resumeContext?: (
    ref: SessionRef
  ) => { cwd: string; spawnTag: string; launchId?: LaunchId } | null
}

/** What a resume needs that `SessionRef` does not carry (package gap): remembered at launch, or read through `resumeContext`. */
interface Remembered {
  readonly cwd: string
  readonly spawnTag: string
  /** The launch whose relay credential a resume carries again (AMENDMENT-21). */
  readonly launchId: LaunchId
  readonly relay: RelayEntryInput
  /** Both delegation gates let the launch in; its resumes keep that listing. */
  readonly delegationGated: boolean
  /** Resumes so far: each writes its own `--mcp-config` file. */
  resumes: number
}

/**
 * What a restarted Host reads of the stored launch record (ISSUE-173): the folder, the spawn tag
 * and the launch (ISSUE-182). It carries no relay credential: the resume asks the launch's live
 * relay again (`PromptToolRelay.reissue`), and starts without the prompt tool when there is none.
 */
interface StoredResume {
  readonly cwd: string
  readonly spawnTag: string
  readonly launchId?: LaunchId
}

function isRemembered(known: Remembered | StoredResume): known is Remembered {
  return 'relay' in known
}

/** The relay entry of a launch: the relay program and the credential FILE PATH (ADR-013 item 3). */
interface RelayEntryInput {
  readonly relay: { readonly program: string; readonly args: readonly string[] }
  readonly credentialFilePath: string
}

export class ClaudeStreamJsonDriver implements ProviderDriver {
  readonly profile: ProviderProfile
  readonly transport = 'stream-json' as const
  private readonly launchIds = new Set<string>()
  /** Session ids whose process this Host holds now (ADR-015: never two writers). */
  private readonly live = new Set<string>()
  private readonly remembered = new Map<string, Remembered | StoredResume>()
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
    // Before any relay credential is issued: no node for a script entry means nothing starts.
    const target = await this.startTarget(req.install.binaryPath)
    const sessionId = this.deps.ids.uuidv7()
    const relay = await this.relayOf(req)
    if (relay === null) {
      throw launchError('could-not-start', 'the permission prompt tool relay could not be issued')
    }
    // Registered before the spawn: claude connects its MCP servers while it starts.
    const prompts = this.promptsFor(req.launchId, relay.gated)
    // A credential this launch was issued never outlives a start that failed; a gated request's
    // own entry is the delegation lifecycle's to revoke (its `revokeLaunch`).
    const release = async (): Promise<void> => {
      prompts.unregister()
      if (!relay.gated) await this.releaseRelay(req.launchId)
    }
    const config = await this.writeMcpConfig(req.launchId, relay.entry).catch(
      async (error: unknown) => {
        await release()
        throw error
      }
    )
    const abandon = async (): Promise<void> => {
      await release()
      await config.remove()
    }
    let argv: string[]
    try {
      argv = buildArgv({
        kind: 'launch',
        sessionId,
        ...(req.model === undefined ? {} : { model: req.model }),
        ...(req.effort === undefined ? {} : { effort: req.effort }),
        mcpConfigPath: config.path,
        delegationGateOn: relay.gated,
        policyArgv: req.permissionMode?.providerArgs.argv ?? []
      })
    } catch {
      await abandon()
      throw launchError('could-not-start', 'the argv was refused (ADR-008 item 3)')
    }
    const spawnedAt = this.deps.clock.now()
    const child = this.spawn(target, argv, req.cwd, req.spawnTag)
    let identity: ProcessIdentity
    try {
      identity = await child.identity
    } catch (error) {
      await abandon()
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
        prompts.unregister()
        void config.remove()
      }
    })
    prompts.bind(session)
    this.live.add(sessionId)
    this.remembered.set(sessionId, {
      cwd: req.cwd,
      spawnTag: req.spawnTag,
      launchId: req.launchId,
      relay: relay.entry,
      delegationGated: relay.gated,
      resumes: 0
    })
    session.writePrompt(req.prompt, this.deps.ids.uuidv7())
    try {
      return await session.ready
    } catch (error) {
      this.live.delete(sessionId)
      // A launch that never became ready is never resumed: its credential is released.
      this.remembered.delete(sessionId)
      await abandon()
      throw error
    }
  }

  async resume(ref: SessionRef): Promise<DriverSession> {
    if (this.live.has(ref.providerSessionId)) {
      throw resumeError('resume-error', 'the session is live in this Host')
    }
    // This instance's own launch first; else the stored launch record (a restarted Host, ISSUE-173).
    const known =
      this.remembered.get(ref.providerSessionId) ?? this.deps.resumeContext?.(ref) ?? undefined
    if (known === undefined) {
      throw resumeError('resume-error', 'the folder and spawn tag of the session are unknown')
    }
    const detected = await this.detect()
    if (detected.kind !== 'installed') throw launchError('not-installed', 'claude is not installed')
    const target = await this.startTarget(detected.install.binaryPath)
    // The launch's relay again (AMENDMENT-21), in a file of its own; no pre-approval on a resume.
    // A stored record (a restarted Host) asks its launch's live relay again (ISSUE-182).
    const relayed = isRemembered(known) ? known : await this.reissuedRelay(known)
    if (relayed !== null) relayed.resumes += 1
    const prompts =
      relayed === null ? null : this.promptsFor(relayed.launchId, relayed.delegationGated)
    const config =
      relayed === null
        ? null
        : await this.writeMcpConfig(
            `${relayed.launchId}.resume-${relayed.resumes}`,
            relayed.relay
          ).catch((error: unknown) => {
            prompts?.unregister()
            throw error
          })
    const abandon = async (): Promise<void> => {
      prompts?.unregister()
      await config?.remove()
    }
    const argv = buildArgv({
      kind: 'resume',
      sessionId: ref.providerSessionId,
      mcpConfigPath: config?.path ?? null,
      policyArgv: []
    })
    const spawnedAt = this.deps.clock.now()
    const child = this.spawn(target, argv, known.cwd, known.spawnTag)
    let identity: ProcessIdentity
    try {
      identity = await child.identity
    } catch (error) {
      await abandon()
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
      onExit: (exited) => {
        this.live.delete(exited.providerSessionId)
        prompts?.unregister()
        void config?.remove()
      }
    })
    prompts?.bind(session)
    let resumed: DriverSession
    try {
      resumed = await session.ready
    } catch (error) {
      await abandon()
      throw error
    }
    this.live.add(resumed.ref.providerSessionId)
    this.remembered.set(resumed.ref.providerSessionId, relayed ?? known)
    return resumed
  }

  /**
   * A restarted Host's resume (ISSUE-182): the live relay of the stored record's launch, reissued
   * with the credential FILE PATH it already had. Its delegation listing is not stored, so the
   * resume lists `permission` only (the two delegation tools stay off, INV-80). `null`: no launch
   * named, or no live relay; the resume then runs without the prompt tool.
   */
  private async reissuedRelay(stored: StoredResume): Promise<Remembered | null> {
    if (stored.launchId === undefined) return null
    const issued = await this.deps.promptTool.relay.reissue(stored.launchId).catch(() => null)
    const relay = issued === null ? null : ticketFileEntry(issued)
    if (relay === null) return null
    return {
      cwd: stored.cwd,
      spawnTag: stored.spawnTag,
      launchId: stored.launchId,
      relay,
      delegationGated: false,
      resumes: 0
    }
  }

  /** 15 §2.1: the ceiling merged with the protocol (nothing yet, S-020-1) and the probe source. */
  private sessionCapabilities(install: InstalledProvider): ProviderCapabilities {
    const probe =
      this.probed.get(installKey(install)) ??
      merge(this.deps.record.ceiling, capabilitiesFromHelp(null, SPIKE_RECORDS))
    return merge(this.deps.record.ceiling, combineLowest({}, probe))
  }

  /**
   * How to start the person's claude, resolved like a binary (ADR-009 D5). On Windows an npm
   * install resolves to its script entry, which the OS cannot start by itself and R17 forbids
   * running through a shell: the person's `node`, found through the same detection, runs it
   * (`adapterLaunch`, #1360). Not installed when that `node` does not resolve: no spawn.
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
    spawnTag: string
  ): SpawnedProcess {
    const env = childEnv(this.deps.loginEnv, spawnTag, {
      providerVars: this.deps.record.providerEnvVars ?? [],
      // The relay is a stdio MCP server claude starts itself, never a loopback HTTP endpoint.
      loopbackRelay: false,
      platform: this.deps.platform
    })
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
   * The launch's relay entry (AMENDMENT-21): a gated request's own `DelegationInjection` (whose
   * pre-approval it carries), else the one `PromptToolRelay.issue` gives. Null when there is none
   * to use: a request entry that is not a `ticket-file` relay, or a relay that was not issued.
   */
  private async relayOf(
    req: DriverLaunchRequest
  ): Promise<{ entry: RelayEntryInput; gated: boolean } | null> {
    if (req.delegation !== null) {
      const entry = ticketFileEntry(req.delegation)
      return entry === null ? null : { entry, gated: true }
    }
    const issued = await this.deps.promptTool.relay.issue(req.launchId).catch(() => null)
    if (issued === null) return null
    const entry = ticketFileEntry(issued)
    if (entry === null) await this.releaseRelay(req.launchId)
    return entry === null ? null : { entry, gated: false }
  }

  /**
   * The launch's prompt-tool registration: made before the spawn, bound to the session once it
   * exists. A call before that, or after the registration ended, is denied (fail closed).
   */
  private promptsFor(
    launchId: LaunchId,
    delegationGated: boolean
  ): {
    bind(session: StreamJsonSession): void
    unregister(): void
  } {
    let session: StreamJsonSession | null = null
    let registered = true
    const unregister = this.deps.promptTool.sessions.register(
      launchId,
      { delegationGated },
      (call, signal) =>
        session === null ? Promise.resolve('deny') : session.promptPermission(call, signal)
    )
    return {
      bind: (bound) => {
        session = bound
      },
      unregister: () => {
        if (!registered) return
        registered = false
        session = null
        unregister()
      }
    }
  }

  /** Revokes a prompt relay credential this driver was issued; a failure is the boot sweep's. */
  private async releaseRelay(launchId: LaunchId): Promise<void> {
    await this.deps.promptTool.relay.release(launchId).catch(() => undefined)
  }

  /** ADR-013 item 3 `ticket-file`: the relay entry with the credential-file path, before the spawn. */
  private async writeMcpConfig(
    name: string,
    entryInput: RelayEntryInput
  ): Promise<{ path: string; remove: () => Promise<void> }> {
    const { dir, files } = this.deps.mcpConfig
    const path = mcpConfigPath(dir, name, this.deps.platform)
    try {
      const entry = relayEntry({
        command: entryInput.relay.program,
        args: entryInput.relay.args,
        credentialFilePath: entryInput.credentialFilePath,
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
  readonly capabilities: ProviderCapabilities
  /** `launch`: the id is the Host's; `resume`: `system/init` names the id it continues. */
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
  /** Resolves at `system/init` (S-020-1); a resume also at the end of the early-failure window. */
  readonly ready: Promise<DriverSession>
  private readonly channel = new EventChannel<DriverEvent>()
  private readonly framer = new LineFramer()
  private settleReady: ((ok: boolean, detail: string) => void) | null = null
  private readonly handshakeTimer: { cancel(): void }
  private readonly windowTimer: { cancel(): void } | null
  private stderrTail = ''
  private openTurns = 0
  private results = 0
  private openUnit: OpenUnit | null = null
  private readonly tools = new Map<string, { toolName: string; summary: string }>()
  /** Open prompt-tool asks by provider request id: each settles its call once (ADR-010). */
  private readonly asks = new Map<string, (decision: 'allow' | 'deny') => void>()
  private asked = 0
  private readonly reported = new Set<string>()
  private closing = false
  private outputEnded = false
  private exitSeen = false
  private exitCode: number | null = null
  private exited = false
  private initSeen = false

  constructor(private readonly options: SessionOptions) {
    this.ref = { ...options.ref }
    this.capabilities = structuredClone(options.capabilities)
    const { child, deps } = options
    this.ready = new Promise<DriverSession>((resolve, reject) => {
      this.settleReady = (ok, detail) => {
        this.settleReady = null
        this.handshakeTimer.cancel()
        this.windowTimer?.cancel()
        if (ok) resolve(this)
        else {
          const early = deps.clock.now() - options.spawnedAt < EARLY_FAILURE_WINDOW_MS
          // The CLI is told to end: it may outlive its error result by seconds (S-020-1).
          this.closeInput()
          reject(options.fail(early && detail !== 'handshake timeout', detail, this.tail()))
        }
      }
    })
    this.handshakeTimer = deps.scheduler.after(HANDSHAKE_TIMEOUT_MS, () => {
      // 15 §1.3: on a handshake timeout the driver closes its transport and rejects.
      this.closeInput()
      this.settleReady?.(false, 'handshake timeout')
    })
    // S-020-1, SP-15: a resumed claude writes nothing before a stdin line, and a resume sends none.
    this.windowTimer =
      options.mode === 'resume'
        ? deps.scheduler.after(EARLY_FAILURE_WINDOW_MS, () => this.settleReady?.(true, 'ready'))
        : null
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
    const held = this.writeUser(input.text, input.messageId, input.messageId, input.attachments)
    // No stream-json acknowledgement of a user line exists (S-022-1): written, not confirmed.
    return { confidence: 'unconfirmed', heldUntilTurnEnd: held, correlation: input.messageId }
  }

  /** `interrupt` is false on this driver (15 §3 row C2): the caller goes to ADR-014's kill. */
  async interrupt(): Promise<void> {}

  /**
   * One prompt-tool call of this session's relay (AMENDMENT-21): one `ask.opened`, settled by the
   * first answer, denied when the call is cancelled (the ask resolved `cancelled`) or the session
   * ends. A call cancelled before it arrives, or on an ended session, opens nothing.
   */
  promptPermission(call: PromptToolCall, signal: AbortSignal): Promise<'allow' | 'deny'> {
    if (this.exited || signal.aborted) return Promise.resolve('deny')
    const id = this.askId(call.toolUseId)
    return new Promise((resolve) => {
      const onAbort = (): void => {
        if (!this.asks.delete(id)) return
        resolve('deny')
        this.emit({ t: 'ask.resolved', providerRequestId: id, by: 'cancelled' })
      }
      this.asks.set(id, (decision) => {
        signal.removeEventListener('abort', onAbort)
        resolve(decision)
      })
      signal.addEventListener('abort', onAbort, { once: true })
      this.emit({
        t: 'ask.opened',
        ask: {
          kind: 'permission',
          providerRequestId: id,
          channel: 'driver',
          payload: {
            toolName: call.toolName,
            requestText: toolSummary(call.toolName, { ...call.input }, this.options.deps.redact)
          },
          // The prompt tool answers allow or deny, nothing wider (15 §2.7): both are offered.
          options: { hasAllowOnce: true, hasRejectOnce: true }
        }
      })
    })
  }

  /** The first answer settles the call; any later or unknown one is `ask-closed` (ADR-010 item 5). */
  async answerPermission(req: {
    providerRequestId: string
    decision: 'allow' | 'deny'
  }): Promise<AnswerOutcome> {
    const settle = this.asks.get(req.providerRequestId)
    if (settle === undefined) return { kind: 'refused', reason: 'ask-closed' }
    this.asks.delete(req.providerRequestId)
    settle(req.decision)
    return { kind: 'accepted' }
  }

  /** A request id unique in this session: the tool use's id, else suffixed by the call ordinal. */
  private askId(toolUseId: string): string {
    this.asked += 1
    return this.asks.has(toolUseId) ? `${toolUseId}:${this.asked}` : toolUseId
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
  private writeUser(
    text: string,
    uuid: string,
    echoOf: string | null,
    attachments: TurnInput['attachments'] = []
  ): boolean {
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
      message: { role: 'user', content: userContentOf(text, attachments) },
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
        if (record.subtype === 'init') this.onInit(record.sessionId)
        return
      case 'assistant':
        this.onAssistant(record)
        return
      case 'user':
        if (record.parentToolUseId !== null) return // a subagent's own tool result
        for (const result of record.toolResults) this.finishTool(result.toolUseId, result.isError)
        return
      case 'result':
        if (this.settleReady !== null && record.isError) {
          // S-020-1: an error result before system/init is the launch (or resume) failing.
          this.settleReady(
            false,
            `claude ended with ${record.subtype || 'an error'} before system/init`
          )
          return
        }
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

  /** `system/init` (S-020-1): readiness, and on a resume the id the CLI continues. */
  private onInit(sessionId: string | null): void {
    if (this.options.mode === 'resume' && !this.initSeen && sessionId !== null) {
      const previous = this.ref.providerSessionId
      if (sessionId !== previous) {
        // ADR-015 item 7: a resume that minted a new id names the one it continues. SP-15 recorded
        // that 2.1.301 keeps the id; its fork shows the shape of one that does not.
        this.ref = {
          ...this.ref,
          providerSessionId: sessionId,
          previousProviderSessionId: previous
        }
      }
    }
    this.initSeen = true
    this.settleReady?.(true, 'ready')
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
    // Fail closed (15 §2.7): a call still open when the session ends is denied.
    for (const settle of this.asks.values()) settle('deny')
    this.asks.clear()
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

/** The `ticket-file` relay entry an injection carries, or null when it carries none. */
function ticketFileEntry(injection: DelegationInjection): RelayEntryInput | null {
  if (
    injection.mechanism !== 'ticket-file' ||
    injection.relay === undefined ||
    injection.credentialFilePath === undefined
  ) {
    return null
  }
  return { relay: injection.relay, credentialFilePath: injection.credentialFilePath }
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

/**
 * The line DwarfAI writes ahead of each file a turn carries (#1463): the same words the legacy held
 * route (`attachmentDelivery.ts` `heldContentFor`, #408) named a file with when it did not send its
 * bytes. Kept here, not imported: a module adapter never imports `contracts` (R9), and the literal
 * the renderer reads is `contracts/text/heldSessionText.ts` `ATTACHED_FILE_PREFIX`.
 */
export const ATTACHED_FILE_PREFIX = 'Attached file: '

/**
 * A user line's text (15 §1.2 `TurnInput.attachments`; US-MSG-002.AC03; package gap, recorded in the
 * #1463 hand-off): one `Attached file: <path>` line per Host-revalidated file, in the order sent,
 * then the person's words, so the person's own claude opens each file with its own tools. Only the
 * path travels, on stdin (never argv); the bytes are never read here (INV-62). A turn with no file
 * is its words exactly as before.
 */
export function userContentOf(text: string, attachments: TurnInput['attachments']): string {
  if (attachments.length === 0) return text
  const named = attachments.map((file) => `${ATTACHED_FILE_PREFIX}${file.path}`)
  return [...named, ...(text === '' ? [] : [text])].join('\n')
}
