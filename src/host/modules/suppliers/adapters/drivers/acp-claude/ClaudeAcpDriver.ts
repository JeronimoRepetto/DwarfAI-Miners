// ClaudeAcpDriver (15 §4.3; ADR-009 D4, D5; AMENDMENT-2): the preferred Claude driver when the
// person installed `claude-agent-acp` themselves. DwarfAI never ships that adapter (it embeds the
// Agent SDK, OQ-52); the driver is offered only when both the person's `claude` and their
// `claude-agent-acp` resolve through the one resolver (ADR-009 D5 (a)). The adapter is spawned
// with the `childEnv` allowlist (15 §4) plus `CLAUDE_CODE_EXECUTABLE` = the person's resolved
// `claude`, the only other DwarfAI-set variable: without it the adapter would fall back to the
// SDK-bundled binary (`clacp@e6681d2:src/acp-agent.ts:1632-1669`; 18 C-18). It speaks ACP through
// the generic client (`../acp/client`, 15 §4.10): permission and question cards through
// `session/request_permission` and form elicitation, resume through `session/load`, and the
// delegation relay only as a `ticket-file` stdio entry of `session/new` (`protocol` only after
// SP-12; the injection itself is ISSUE-201's).
//
// No auto-approve option anywhere (ADR-008 item 3), no provider credential read (ADR-008 item 2),
// no `fs` or `terminal` client capability (15 §4.10). The driver never signals a process: ending
// one is ADR-014's `SessionTerminator` (`close('end-thread')`, then the tree kill).
//
// Candidate decision (21 §6): no candidate, new code (ISSUE-151 "Existing code").
import type { ProcessIdentity } from '../../../../../kernel/domain/processIdentity'
import type { McpServer } from '@agentclientprotocol/sdk'
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
import { relayEntry } from '../shared/relayEntry'

/** The adapter's binary name: always the person's own install (15 §2.4 row Claude `acp`). */
export const ADAPTER_BINARY = 'claude-agent-acp'
/** What a Windows npm adapter entry runs with: the person's own `node`, never a bundled one. */
const NODE_BINARY = 'node'
/** The variable that pins the adapter to the person's `claude` (15 §2.4, §4.3). */
export const EXECUTABLE_PIN = 'CLAUDE_CODE_EXECUTABLE'
/** The Jev entry's name in `session/new` `mcpServers` (ADR-013 item 3). */
const RELAY_NAME = 'dwarfai'
/**
 * AMENDMENT-19 (owner, 2026-10-17; ADR-008 item 3): claude-agent-acp starts a session in the
 * person's own `permissions.defaultMode`, which may skip the permission check. The adapter's
 * client options live in `_meta.claudeCode.options` (claude-agent-acp 0.93.0 README; its
 * `acp-agent.js` reads `allowDangerouslySkipPermissions` there), and `false` refuses every
 * skip-permission mode for the session.
 */
const SESSION_META: Readonly<Record<string, unknown>> = Object.freeze({
  claudeCode: { options: { allowDangerouslySkipPermissions: false } }
})
/** The mode a session must report before it is ready: Claude asks before every change. */
const PINNED_MODE = 'default'
/** JSON-RPC "resource not found": the adapter does not know the session id (ADR-015 stale ref). */
const RESOURCE_NOT_FOUND = -32002

/**
 * 15 §3 row C3 (design values; NFR-OBS-04: no recording yet). One value is lower than the row,
 * fail closed: `usage.rateLimits` stays false until a recording shows the shape of
 * `_meta["_claude/rateLimit"]` (`acp-agent.ts:6329-6338`). Observed-session fields are `n/a`.
 */
export const C3_ROW: ProviderCapabilities = Object.freeze({
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'interactive',
  question: 'form',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'load',
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'transcript',
  usage: Object.freeze({ fidelity: 1, rateLimits: false }),
  mcpInjection: 'ticket-file',
  console: 'log',
  earlyFailure: 'handshake',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
}) as ProviderCapabilities

export type Platform = 'win32' | 'darwin' | 'linux'

export interface ClaudeAcpDriverDeps {
  /** The Claude catalog record: profile, ceiling and documented variables (`profiles.ts`). */
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

/** What a resume needs that `SessionRef` does not carry (package gap, as the stream-json driver). */
interface Remembered {
  readonly cwd: string
  readonly spawnTag: string
}

export class ClaudeAcpDriver implements ProviderDriver {
  readonly profile: ProviderProfile
  readonly transport = 'acp' as const
  private readonly launchIds = new Set<string>()
  /** Session ids whose adapter this Host holds now (ADR-015: never two writers). */
  private readonly live = new Set<string>()
  private readonly remembered = new Map<string, Remembered>()
  /** The last probe per install: the session's probe source (15 §2.1). */
  private readonly probed = new Map<string, ProviderCapabilities>()

  constructor(private readonly deps: ClaudeAcpDriverDeps) {
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

  /** No process is started: the row is design data, closed by the SDK's licence record. */
  async probe(install: InstalledProvider): Promise<ProviderCapabilities> {
    const caps = merge(this.deps.record.ceiling, acpProbeSource(C3_ROW, this.library))
    this.probed.set(installKey(install), caps)
    return structuredClone(caps)
  }

  async launch(req: DriverLaunchRequest): Promise<DriverSession> {
    if (this.launchIds.has(req.launchId)) {
      throw launchError('could-not-start', 'launch id already used')
    }
    this.launchIds.add(req.launchId)
    if (!this.library.s0081) {
      throw launchError('could-not-start', 'the ACP TS SDK has no S-008-1 record')
    }
    const adapter = await this.adapterTarget()
    let session: DriverSession
    try {
      session = await startAcpSession(this.deps, {
        ...this.startOf(req.install, adapter, req.cwd, req.spawnTag),
        mcpServers: this.mcpServers(req),
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
    const detected = await this.detect()
    if (detected.kind !== 'installed') throw launchError('not-installed', 'claude is not installed')
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

  /**
   * How to start the person's `claude-agent-acp`, resolved like a binary (ADR-009 D5). On Windows
   * an npm install resolves to its `.js` entry, started by the person's `node` through the same
   * resolver (`adapterLaunch`, #1360). Not installed when either does not resolve: no spawn.
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
      // The relay is a stdio MCP server the adapter starts itself, never a loopback endpoint.
      loopbackRelay: false,
      platform: this.deps.platform
    })
    // 15 §4.3: the adapter runs the person's own claude, never an SDK-bundled one (C-18).
    env[EXECUTABLE_PIN] = install.binaryPath
    const probe =
      this.probed.get(installKey(install)) ??
      merge(this.deps.record.ceiling, acpProbeSource(C3_ROW, this.library))
    return {
      providerId: this.profile.id,
      executable: adapter.program,
      args: [...adapter.leadingArgs],
      cwd,
      env,
      sessionMeta: SESSION_META,
      pinnedMode: PINNED_MODE,
      capabilitiesFor: (init) =>
        merge(this.deps.record.ceiling, combineLowest(protocolSource(init), probe)),
      onExit: (ref) => this.live.delete(ref.providerSessionId)
    }
  }

  /** ADR-013 item 3 `ticket-file`: the relay entry with the credential-file path, never a value. */
  private mcpServers(req: DriverLaunchRequest): McpServer[] {
    const delegation = req.delegation
    if (
      delegation === null ||
      delegation.mechanism !== 'ticket-file' ||
      delegation.relay === undefined ||
      delegation.credentialFilePath === undefined
    ) {
      return []
    }
    const entry = relayEntry({
      command: delegation.relay.program,
      args: delegation.relay.args,
      credentialFilePath: delegation.credentialFilePath,
      platform: this.deps.platform
    })
    return [
      {
        name: RELAY_NAME,
        command: entry.command,
        args: [...entry.args],
        env: Object.entries(entry.env).map(([name, value]) => ({ name, value }))
      }
    ]
  }
}

function installKey(install: InstalledProvider): string {
  return JSON.stringify([install.binaryPath, install.version, install.statMtimeMs])
}

/**
 * ADR-020 D4: spawn ENOENT is not-installed; an exit inside 3 s is exited-at-once. A session that
 * cannot be put in the pinned mode (AMENDMENT-19) is could-not-start (D1 cause 3: the adapter was
 * found and ran, but would not start the way DwarfAI requires), never an early exit.
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
