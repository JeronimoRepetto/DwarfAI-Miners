// AcpDriver (15 §4.10; ADR-009 D4): the one driver for any catalog provider whose agent speaks ACP
// natively (OpenCode `acp`, ISSUE-155; Kiro, ISSUE-158; later Gemini). It is configured only by
// catalog data: the provider's record (profile, ceiling, documented variables), the arguments that
// start its agent over ACP (`kiro-cli acp`: `['acp']`), the provider's 15 §3 row for that channel
// and, where the agent has session modes, the mode that asks before every change. It holds no
// provider-id literal (R12): every provider fact comes from that data.
//
// The agent binary is always the person's own (`detect()` through the one resolver, ADR-009 D5),
// spawned with `shell: false` and the `childEnv` allowlist (15 §4), and spoken to through the
// shared client (`./client`): `initialize` declares only `elicitation.form`, never `fs` or
// `terminal`; `session/new {cwd, mcpServers}`; turns are `session/prompt` (`stopReason` per
// ADR-021 item 5); `session/cancel`, `session/close`; resume by `session/load` (replays) or
// `session/resume` (no replay) as `initialize` advertises, else `resume: 'none'`. The probe is
// `<binary> --help`: `launch` stays open only when the help lists the ACP arguments.
//
// Permission (15 §2.7, ADR-008 item 3): Allow is `allow_once`, Deny is `reject_once`; an option
// set with neither is answered with a JSON-RPC error (F-ACP-NOREJECT, fail closed). A session
// that reports a mode named like one of ADR-008 item 3's auto-approve options is refused, unless
// the record pins a mode, which is then set before the first prompt (AMENDMENT-19 applied to any
// ACP agent). A provider with `permission: 'none'` and no verified deny is not launchable in
// public builds: its record is gated (`publicLaunchOf`, ADR-011 item 1).
//
// No auto-approve option anywhere, no provider credential read (ADR-008 items 2, 3). The driver
// never signals a session's process (ADR-014); the only process it ends is a `--help` probe that
// outlived PROBE_TIMEOUT_MS, by identity.
//
// Candidate decision (21 §6): no candidate, new code (ISSUE-154 "Existing code").
import type { McpServer } from '@agentclientprotocol/sdk'
import type { ProcessIdentity } from '../../../../../kernel/domain/processIdentity'
import type { Clock } from '../../../../../kernel/ports/clock'
import type { ProcessControl } from '../../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../../kernel/ports/scheduler'
import { detectForDriver, type InstallDetection } from '../../../application/detection'
import { PROBE_TIMEOUT_MS } from '../../../application/probe'
import type { ProviderCapabilities } from '../../../domain/capabilities'
import {
  combineLowest,
  merge,
  type NegotiatedCapabilities
} from '../../../domain/mergeCapabilities'
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
import { probeEnv } from '../../install/searchDirs'
import { childEnv, type LoginEnvironment } from '../shared/childEnv'
import { FORBIDDEN_FLAGS } from '../shared/forbiddenFlags'
import { relayEntry } from '../shared/relayEntry'
import {
  startAcpSession,
  type AcpSession,
  type AcpStart,
  type HandshakeFailure
} from './client/AcpClient'
import { adapterLaunch, type LaunchTarget } from './client/adapterLaunch'
import {
  ACP_SDK_RECORD,
  acpProbeSource,
  protocolSource,
  type AcpLibraryRecord
} from './client/capabilities'

/** What a Windows npm entry of the agent runs with: the person's own `node`, never a bundled one. */
const NODE_BINARY = 'node'
/** The Jev entry's name in `session/new` `mcpServers` (ADR-013 item 3). */
const RELAY_NAME = 'dwarfai'
/** JSON-RPC "resource not found": the agent does not know the session id (ADR-015 stale ref). */
const RESOURCE_NOT_FOUND = -32002
/** A `--help` probe reads at most this much. */
const HELP_READ_CHARS = 256 * 1024

/**
 * A provider's 15 §3 row for the generic ACP driver. It names no `resume`: how a session resumes
 * is what the agent's `initialize` offers (`session/load`, `session/resume` or neither; 15 §2.2
 * row `acp`), within the ceiling.
 */
export type AcpRow = Omit<ProviderCapabilities, 'resume'>

export type Platform = 'win32' | 'darwin' | 'linux'

export interface AcpDriverDeps {
  /** The provider's catalog record: profile, ceiling and documented variables (`profiles.ts`). */
  readonly record: CatalogRecord
  /**
   * The provider's 15 §3 row for its ACP channel, recorded with version and date (15 §7 step 10):
   * the driver's design source, every unverified field at its weakest value (INV-44).
   */
  readonly row: AcpRow
  /** The arguments that start the person's agent over ACP (catalog data, e.g. `['acp']`). */
  readonly agentArgs: readonly string[]
  /**
   * AMENDMENT-19 for an agent with session modes: the mode that asks before every change, set
   * with `session/set_mode` before the first prompt. Absent: the agent's own mode is kept, unless
   * it skips the permission ask (then the launch fails closed).
   */
  readonly pinnedMode?: string
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
  /** One-line redaction of activity summaries and card lines (bound by wiring). */
  readonly redact: (text: string) => string
  /** The S-008-1 record of the ACP TS SDK (default: this build's, `ACP_SDK_RECORD`). */
  readonly acpLibrary?: AcpLibraryRecord
}

/** What a resume needs that `SessionRef` does not carry (package gap, as the other drivers). */
interface Remembered {
  readonly cwd: string
  readonly spawnTag: string
  /** The last session with this id: its turns and how `initialize` let it resume. */
  readonly session: AcpSession
}

/** ADR-008 item 3's names as a mode id would spell them: letters and digits, lower case. */
const REFUSED_MODES: readonly string[] = FORBIDDEN_FLAGS.map(modeWord)

function modeWord(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Whether a session mode is named like an ADR-008 item 3 auto-approve option. */
export function skipsPermissionAsk(modeId: string): boolean {
  const word = modeWord(modeId)
  return word !== '' && REFUSED_MODES.some((refused) => word.includes(refused))
}

/** Whether the help output lists every ACP argument as a word of its own. */
export function helpOffers(help: string, agentArgs: readonly string[]): boolean {
  const words = new Set(help.split(/[\s,;|()[\]<>]+/))
  return agentArgs.every((arg) => words.has(arg))
}

export class AcpDriver implements ProviderDriver {
  readonly profile: ProviderProfile
  readonly transport = 'acp' as const
  private readonly launchIds = new Set<string>()
  /** Session ids whose agent this Host holds now (ADR-015: never two writers). */
  private readonly live = new Set<string>()
  private readonly remembered = new Map<string, Remembered>()
  /** The last probe source per install: the session's probe source (15 §2.1). */
  private readonly probed = new Map<string, NegotiatedCapabilities>()

  /** The row as a probe source: never a `resume` (a row typed wider still names none). */
  private readonly row: NegotiatedCapabilities

  constructor(private readonly deps: AcpDriverDeps) {
    this.profile = deps.record.profile
    const row: NegotiatedCapabilities = { ...deps.row }
    delete row.resume
    this.row = row
  }

  private get library(): AcpLibraryRecord {
    return this.deps.acpLibrary ?? ACP_SDK_RECORD
  }

  detect(): Promise<DetectResult> {
    return detectForDriver(this.deps.detection, {
      providerId: this.profile.id,
      binaries: this.profile.binaries
    })
  }

  /** `<binary> --help` (15 §2.3): no help, or one without the ACP arguments, closes `launch`. */
  async probe(install: InstalledProvider): Promise<ProviderCapabilities> {
    let help: string | null
    try {
      help = await this.readHelp(install)
    } catch {
      help = null
    }
    const offered = help !== null && helpOffers(help, this.deps.agentArgs)
    const row: NegotiatedCapabilities = offered ? this.row : { ...this.row, launch: false }
    const source = acpProbeSource(row, this.library)
    this.probed.set(installKey(install), source)
    return merge(this.deps.record.ceiling, source)
  }

  async launch(req: DriverLaunchRequest): Promise<DriverSession> {
    if (this.launchIds.has(req.launchId)) {
      throw launchError('could-not-start', 'launch id already used')
    }
    this.launchIds.add(req.launchId)
    if (!this.library.s0081) {
      throw launchError('could-not-start', 'the ACP TS SDK has no S-008-1 record')
    }
    const agent = await this.agentTarget(req.install)
    let session: AcpSession
    try {
      session = await startAcpSession(this.deps, {
        ...this.startOf(req.install, agent, req.cwd, req.spawnTag),
        mcpServers: this.mcpServers(req),
        mode: { kind: 'new', prompt: req.prompt },
        onSpawned: (identity: ProcessIdentity) => req.onSpawned(identity)
      })
    } catch (failure) {
      throw launchFailure(failure as HandshakeFailure)
    }
    const id = session.ref.providerSessionId
    this.live.add(id)
    this.remembered.set(id, { cwd: req.cwd, spawnTag: req.spawnTag, session })
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
    if (known.session.capabilities.resume === 'none') {
      // `initialize` offered neither method: nothing is spawned to find that out again.
      throw resumeError('resume-error', 'the agent offers neither session/load nor session/resume')
    }
    const detected = await this.detect()
    if (detected.kind !== 'installed') {
      throw launchError('not-installed', `${this.profile.label} is not installed`)
    }
    const agent = await this.agentTarget(detected.install)
    let session: AcpSession
    try {
      session = await startAcpSession(this.deps, {
        ...this.startOf(detected.install, agent, known.cwd, known.spawnTag),
        mcpServers: [],
        mode: {
          kind: 'resume',
          sessionId: ref.providerSessionId,
          turnsBefore: known.session.turns
        }
      })
    } catch (failure) {
      const { spawnCode, code, detail } = failure as HandshakeFailure
      if (spawnCode === 'ENOENT') throw launchError('not-installed', detail)
      throw resumeError(code === RESOURCE_NOT_FOUND ? 'stale-ref' : 'resume-error', detail)
    }
    this.live.add(session.ref.providerSessionId)
    this.remembered.set(session.ref.providerSessionId, { ...known, session })
    return session
  }

  /**
   * How to start the person's agent: its resolved binary with the ACP arguments. On Windows an
   * npm install resolves to a `.js` entry, started by the person's `node` through the same
   * resolver (`adapterLaunch`, #1360); not installed when that does not resolve: no spawn.
   */
  private async agentTarget(install: InstalledProvider): Promise<LaunchTarget> {
    const target = await adapterLaunch(install.binaryPath, this.deps.platform, async () => {
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

  /** The probe source of an install: its last probe, else the row (no process is started). */
  private probeOf(install: InstalledProvider): NegotiatedCapabilities {
    return this.probed.get(installKey(install)) ?? acpProbeSource(this.row, this.library)
  }

  private startOf(
    install: InstalledProvider,
    agent: LaunchTarget,
    cwd: string,
    spawnTag: string
  ): Omit<AcpStart, 'mcpServers' | 'mode'> {
    const env = childEnv(this.deps.loginEnv, spawnTag, {
      providerVars: this.deps.record.providerEnvVars ?? [],
      // The relay is a stdio MCP server the agent starts itself, never a loopback endpoint.
      loopbackRelay: false,
      platform: this.deps.platform
    })
    const probe = this.probeOf(install)
    return {
      providerId: this.profile.id,
      executable: agent.program,
      args: [...agent.leadingArgs, ...this.deps.agentArgs],
      cwd,
      env,
      ...(this.deps.pinnedMode === undefined ? {} : { pinnedMode: this.deps.pinnedMode }),
      refusedMode: skipsPermissionAsk,
      capabilitiesFor: (init) =>
        merge(this.deps.record.ceiling, combineLowest(protocolSource(init), probe)),
      onExit: (ref) => this.live.delete(ref.providerSessionId)
    }
  }

  /**
   * ADR-013 item 3 `ticket-file`: the relay entry with the credential-file path, never a value,
   * only when the provider's row verified that injection (15 §7 step 8: `none` until then).
   */
  private mcpServers(req: DriverLaunchRequest): McpServer[] {
    const delegation = req.delegation
    if (
      this.probeOf(req.install).mcpInjection !== 'ticket-file' ||
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

  /**
   * `<binary> --help` with an argv array and the probe environment, bounded by PROBE_TIMEOUT_MS; a
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

function installKey(install: InstalledProvider): string {
  return JSON.stringify([install.binaryPath, install.version, install.statMtimeMs])
}

/**
 * ADR-020 D4: spawn ENOENT is not-installed; an exit inside 3 s is exited-at-once. A session in a
 * mode that skips the ask, or that cannot be put in the pinned mode, is could-not-start (D1 cause
 * 3: the agent ran, but would not start the way DwarfAI requires), never an early exit.
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
