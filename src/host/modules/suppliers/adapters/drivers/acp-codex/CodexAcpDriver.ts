// CodexAcpDriver (15 §4.5; ADR-009 D4, D5): the Codex fallback, offered when the person's own
// `codex app-server` is not (the Codex profile's second driver, `profiles.ts`). It speaks ACP to the
// person's own `codex-acp` through the generic client (`../acp/client`, 15 §4.10). No S-008-1 row
// allows bundling `codex-acp`, so it is an executable adapter the person installs (ADR-009 D5 (a)):
// the driver is offered only when both the person's `codex` and their `codex-acp` resolve through
// the one resolver, and nothing is spawned otherwise.
//
// The adapter is spawned with the `childEnv` allowlist (15 §4; it forwards its environment to
// `codex`) plus the two variables DwarfAI sets, both documented by the adapter (cxacp@bf37821
// README "Configuration"):
// - `CODEX_PATH` = the person's resolved `codex` (18 C-18): without it the adapter runs its own
//   bundled `@openai/codex` (`src/CodexJsonRpcConnection.ts:19-26`).
// - `INITIAL_AGENT_MODE` = `workspace-write` (AMENDMENT-19, ADR-008 item 3). The adapter's default
//   mode `agent` lets Codex's own reviewer approve actions (`approvalsReviewer: auto_review`) and
//   `agent-full-access` asks nothing (`approvalPolicy: never`); `workspace-write` and `read-only`
//   are `on-request` with the person as reviewer (`src/AgentMode.ts`). `workspace-write` is the one
//   that matches the app-server driver's `approvalPolicy: on-request` with no sandbox lift. The
//   session must then report it, else the client sends `session/set_mode`, else the launch fails
//   closed (`pinnedMode`, AMENDMENT-19 item 2).
//
// Never the adapter's `cli` or `login` subcommands, and never on Windows: there cxacp@bf37821
// starts a pinned `codex` through `shell: true` (`src/CodexJsonRpcConnection.ts:19-22`, and
// `src/CodexCli.ts:26-30` for `cli`), which 18 C-17 forbids, so on Windows the probe reports
// `launch: false` and a launch is refused before any spawn (Codex keeps its app-server driver).
// No question card (15 §3 row X2: `question` U→none; the client declares no elicitation) and no delegation relay (`mcpInjection` U→none
// until SP-12 lists codex-acp; ISSUE-202). A Deny prefers the native `decline` (`denyMapping.ts`, the client's permission-reply hook).
// No auto-approve option anywhere (ADR-008 item 3), no provider credential read (item 2), no `fs`
// or `terminal` client capability (15 §4.10). The driver never signals a process: ending one is
// ADR-014's `SessionTerminator`.
//
// Candidate decision (21 §6): no candidate, new code (ISSUE-153 "Existing code").
import type { ProcessIdentity } from '../../../../../kernel/domain/processIdentity'
import type { Clock } from '../../../../../kernel/ports/clock'
import type { ProcessControl } from '../../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../../kernel/ports/scheduler'
import { detectForDriver, type InstallDetection } from '../../../application/detection'
import type { ProviderCapabilities } from '../../../domain/capabilities'
import { combineLowest, merge } from '../../../domain/mergeCapabilities'
import type { CatalogRecord, ProviderProfile } from '../../../domain/profile'
import type {
  DetectResult,
  DriverLaunchError,
  DriverLaunchRequest,
  DriverResumeError,
  DriverSession,
  InstalledProvider,
  ProviderDriver,
  SessionRef
} from '../../../ports/providerDriver'
import { startAcpSession, type AcpStart, type HandshakeFailure } from '../acp/client/AcpClient'
import { adapterLaunch, type LaunchTarget } from '../acp/client/adapterLaunch'
import {
  ACP_SDK_RECORD,
  acpProbeSource,
  protocolSource,
  type AcpLibraryRecord
} from '../acp/client/capabilities'
import { childEnv, type LoginEnvironment } from '../shared/childEnv'
import { codexDecline } from './denyMapping'

/** The adapter's binary name: the person's own install (15 §2.4 row Codex `acp`). */
export const ADAPTER_BINARY = 'codex-acp'
/** What a Windows npm adapter entry would run with: the person's own `node`, never a bundled one. */
const NODE_BINARY = 'node'
/** The variable that pins the adapter to the person's `codex` (15 §2.4, §4.5). */
export const CODEX_PATH = 'CODEX_PATH'
/** The adapter's documented initial-mode variable (AMENDMENT-19). */
export const MODE_PIN = 'INITIAL_AGENT_MODE'
/** The mode a session must report before it is ready: Codex asks the person (on-request). */
export const PINNED_MODE = 'workspace-write'
/** JSON-RPC "resource not found": the adapter does not know the session id (ADR-015 stale ref). */
const RESOURCE_NOT_FOUND = -32002
const NO_SHELL_ON_WINDOWS = 'codex-acp starts codex through a shell on Windows'

/** 15 §3 row X2 (design values; no recording yet): every `U→x` value counted as its `x`. */
export const X2_ROW: ProviderCapabilities = Object.freeze({
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'interactive',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'load',
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'none',
  usage: Object.freeze({ fidelity: 1, rateLimits: false }),
  mcpInjection: 'none',
  console: 'log',
  earlyFailure: 'handshake',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
}) as ProviderCapabilities

export type Platform = 'win32' | 'darwin' | 'linux'

export interface CodexAcpDriverDeps {
  /** The Codex catalog record: profile, ceiling and documented variables (`profiles.ts`). */
  readonly record: CatalogRecord
  /** The one install detection behind every `detect()` (ADR-009 D5). */
  readonly detection: InstallDetection
  readonly processControl: ProcessControl
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** The person's login environment `childEnv` copies named variables from (15 §4). */
  readonly loginEnv: LoginEnvironment
  readonly platform: Platform
  /** One-line redaction of activity summaries and card lines (bound by wiring). */
  readonly redact: (text: string) => string
  /** The S-008-1 record of the ACP TS SDK (default: this build's, `ACP_SDK_RECORD`). */
  readonly acpLibrary?: AcpLibraryRecord
}

/** What a resume needs that `SessionRef` does not carry (package gap, as the Claude acp driver). */
interface Remembered {
  readonly cwd: string
  readonly spawnTag: string
}

export class CodexAcpDriver implements ProviderDriver {
  readonly profile: ProviderProfile
  readonly transport = 'acp' as const
  private readonly launchIds = new Set<string>()
  /** Session ids whose adapter this Host holds now (ADR-015: never two writers). */
  private readonly live = new Set<string>()
  private readonly remembered = new Map<string, Remembered>()

  constructor(private readonly deps: CodexAcpDriverDeps) {
    this.profile = deps.record.profile
  }

  private get library(): AcpLibraryRecord {
    return this.deps.acpLibrary ?? ACP_SDK_RECORD
  }

  detect(): Promise<DetectResult> {
    return detectForDriver(this.deps.detection, {
      providerId: this.profile.id,
      binaries: this.profile.binaries,
      adapterBinaries: [ADAPTER_BINARY]
    })
  }

  /** No process is started: the row is design data, closed by the SDK record and on Windows. */
  async probe(_install: InstalledProvider): Promise<ProviderCapabilities> {
    return structuredClone(this.probeSource())
  }

  async launch(req: DriverLaunchRequest): Promise<DriverSession> {
    if (this.launchIds.has(req.launchId)) {
      throw launchError('could-not-start', 'launch id already used')
    }
    this.launchIds.add(req.launchId)
    if (!this.library.s0081) {
      throw launchError('could-not-start', 'the ACP TS SDK has no S-008-1 record')
    }
    if (this.deps.platform === 'win32') throw launchError('could-not-start', NO_SHELL_ON_WINDOWS)
    const adapter = await this.adapterTarget()
    let session: DriverSession
    try {
      session = await startAcpSession(this.deps, {
        ...this.startOf(req.install, adapter, req.cwd, req.spawnTag),
        // mcpInjection none (15 §3 row X2): no relay entry, even for a delegation launch.
        mcpServers: [],
        mode: { kind: 'new', prompt: req.prompt },
        onSpawned: (identity: ProcessIdentity) => req.onSpawned(identity)
      })
    } catch (failure) {
      throw launchFailure(failure as HandshakeFailure)
    }
    const id = session.ref.providerSessionId
    this.live.add(id)
    this.remembered.set(id, { cwd: req.cwd, spawnTag: req.spawnTag })
    return session
  }

  async resume(ref: SessionRef): Promise<DriverSession> {
    if (this.live.has(ref.providerSessionId)) {
      throw resumeError('resume-error', 'the session is live in this Host')
    }
    const known = this.remembered.get(ref.providerSessionId)
    if (known === undefined) {
      throw resumeError('resume-error', 'the folder and spawn tag of the session are unknown')
    }
    if (this.deps.platform === 'win32') throw resumeError('resume-error', NO_SHELL_ON_WINDOWS)
    const detected = await this.detect()
    if (detected.kind !== 'installed') throw launchError('not-installed', 'codex is not installed')
    const adapter = await this.adapterTarget()
    let session: DriverSession
    try {
      session = await startAcpSession(this.deps, {
        ...this.startOf(detected.install, adapter, known.cwd, known.spawnTag),
        mcpServers: [],
        mode: { kind: 'resume', sessionId: ref.providerSessionId }
      })
    } catch (failure) {
      const { spawnCode, code, detail } = failure as HandshakeFailure
      if (spawnCode === 'ENOENT') throw launchError('not-installed', detail)
      throw resumeError(code === RESOURCE_NOT_FOUND ? 'stale-ref' : 'resume-error', detail)
    }
    this.live.add(session.ref.providerSessionId)
    return session
  }

  /** The probe source: row X2, launch closed without the SDK record and on Windows (18 C-17). */
  private probeSource(): ProviderCapabilities {
    const row = acpProbeSource(X2_ROW, this.library)
    return merge(
      this.deps.record.ceiling,
      this.deps.platform === 'win32' ? { ...row, launch: false } : row
    )
  }

  /**
   * How to start the person's `codex-acp`, resolved like a binary (ADR-009 D5) and started with no
   * argument (the ACP server; never `cli` or `login`). Not installed when it does not resolve.
   */
  private async adapterTarget(): Promise<LaunchTarget> {
    const resolve = async (binary: string): Promise<string | null> => {
      const found = await this.deps.detection.detect({
        providerId: this.profile.id,
        binaries: [binary]
      })
      return found.kind === 'installed' ? found.install.binaryPath : null
    }
    const adapter = await resolve(ADAPTER_BINARY)
    if (adapter === null) throw launchError('not-installed', `${ADAPTER_BINARY} is not installed`)
    const target = await adapterLaunch(adapter, this.deps.platform, () => resolve(NODE_BINARY))
    if (target === null) {
      throw launchError(
        'not-installed',
        `${NODE_BINARY}, which runs ${ADAPTER_BINARY}, is not installed`
      )
    }
    return target
  }

  private startOf(
    install: InstalledProvider,
    adapter: LaunchTarget,
    cwd: string,
    spawnTag: string
  ): Omit<AcpStart, 'mcpServers' | 'mode'> {
    const env = childEnv(this.deps.loginEnv, spawnTag, {
      providerVars: this.deps.record.providerEnvVars ?? [],
      loopbackRelay: false,
      platform: this.deps.platform
    })
    // 15 §4.5: the adapter runs the person's own codex, never its bundled one (C-18), and starts in
    // the mode that asks the person (AMENDMENT-19). Set after the allowlist: the login values of
    // the same names never apply.
    env[CODEX_PATH] = install.binaryPath
    env[MODE_PIN] = PINNED_MODE
    const probe = this.probeSource()
    return {
      providerId: this.profile.id,
      executable: adapter.program,
      args: [...adapter.leadingArgs],
      cwd,
      env,
      pinnedMode: PINNED_MODE,
      // Row X2: no question card, so no elicitation is declared and every form is refused.
      elicitation: 'none',
      // 15 §2.7: a Deny prefers the native decline (denyMapping.ts).
      permissionReply: codexDecline,
      capabilitiesFor: (init) =>
        merge(this.deps.record.ceiling, combineLowest(protocolSource(init), probe)),
      onExit: (ref) => this.live.delete(ref.providerSessionId)
    }
  }
}

/**
 * ADR-020 D4: spawn ENOENT is not-installed; an exit inside 3 s is exited-at-once. A session that
 * cannot be put in the pinned mode (AMENDMENT-19) is could-not-start, never an early exit.
 */
function launchFailure(failure: HandshakeFailure): DriverLaunchError {
  if (failure.spawnCode === 'ENOENT') return launchError('not-installed', failure.detail)
  return launchError(
    failure.early ? 'exited-at-once' : 'could-not-start',
    failure.detail,
    failure.spawnCode === undefined ? failure.tail : ''
  )
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
