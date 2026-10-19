// OpenCodeServerDriver (`http-server`, 15 §4.6; ADR-009 D4): OpenCode's preferred driver, gated by
// S-031-3. S-031-3 failed at OpenCode 1.18.32 (`spike-results/S-031-3.md`): the server password
// goes only through argv or env (ADR-017 item 3 forbids both) and `opencode serve` has no
// owner-only endpoint. So the selected launch mode is none (`SERVER_PROTECTION`): the driver
// starts no server, its probe reports `launch: false`, and option (c), OpenCode's `acp` entry
// (`OPENCODE_ACP`, the generic AcpDriver), is the driver probing selects (FM-084). A loopback
// listener without a password is never started (ADR-009 D4, NFR-SEC-06).
//
// The person-run attach (ISSUE-237, `./personRunServer`): `personRunServer(url)` talks to the
// person's own loopback `opencode serve` with their stored password, in the `Authorization` header
// only (ADR-017 item 3); the Host's own servers never use it.
//
// What stays here, for the day S-031-3 records (a) or (b): the probe (`opencode --help` for `serve`, ADR-009 D4), the reply vocabulary
// (`./permissionMapping`: `once` / `reject`, never `always`), the SP-14 close (`./serverRequests`),
// the `OPENCODE_CONFIG_CONTENT` relay entry and the event stream parser (`./serverEvents`). The
// answer-channel gate is the profile's (`answerChannelGate`), applied with the capability data
// (15 §2.1), never here.
//
// No provider credential is read (`auth.json`, ADR-008 item 2); no process but the `--help` probe is
// spawned, with `shell: false` and the probe environment, and ended by identity when it outlives
// PROBE_TIMEOUT_MS (ADR-014).
//
// Candidate decision (21 §6), evidence: this suite and `permissionMapping.test.ts`.
// - `src/main/opencodePermissions/answerOpenCodePermission.ts`: replaced. It posts
//   `session/{id}/permissions/{permissionId}` with `{response}` and types `always` as sendable;
//   OpenCode 1.18.32 answers `POST /permission/{id}/reply` with `{reply}` (S-011-1), and `always`
//   is never sent (ADR-008 item 3).
// - `src/main/opencodePermissions/openCodePermissionRegistry.ts`: replaced. It holds asks pushed
//   by the old plugin's `permission.ask` hook, which OpenCode 1.18.32 never calls (S-011-1); asks
//   come from the server's event stream (`permission.asked`) and `GET /permission`.
// - `src/main/providers/opencode/*`: not a candidate. It reads the observed transcript store (row
//   O3), owned by the observation module's OpenCode adapter, and holds no server call.
import type { ProcessControl } from '../../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../../kernel/ports/scheduler'
import { detectForDriver, type InstallDetection } from '../../../application/detection'
import { PROBE_TIMEOUT_MS } from '../../../application/probe'
import type { ProviderCapabilities } from '../../../domain/capabilities'
import { merge } from '../../../domain/mergeCapabilities'
import type { CatalogRecord, ProviderProfile } from '../../../domain/profile'
import type {
  DetectResult,
  DriverLaunchError,
  DriverResumeError,
  DriverSession,
  InstalledProvider,
  ProviderDriver,
  SessionRef
} from '../../../ports/providerDriver'
import { probeEnv } from '../../install/searchDirs'
import { helpOffers } from '../acp/AcpDriver'
import type { LoginEnvironment } from '../shared/childEnv'
import { O1_ROW, SERVER_PROTECTION } from './capabilities'
import { OpenCodeServerClient, type OpenCodeServerClientDeps } from './personRunServer'

/** The subcommand that starts the server (15 §2.3 OpenCode row). */
const SERVE_ARGS: readonly string[] = ['serve']
/** A `--help` probe reads at most this much. */
const HELP_READ_CHARS = 256 * 1024

export interface OpenCodeServerDriverDeps {
  /** OpenCode's catalog record (`profiles.ts`). */
  readonly record: CatalogRecord
  /** The one install detection behind every `detect()` (ADR-009 D5). */
  readonly detection: InstallDetection
  readonly processControl: ProcessControl
  readonly scheduler: Scheduler
  /** The person's login environment the probe environment is built from (15 §4). */
  readonly loginEnv: LoginEnvironment
  /** The folder a `--help` probe runs in (the person's home). */
  readonly home: string
  readonly platform: 'win32' | 'darwin' | 'linux'
  /**
   * How the driver reaches a person-run `opencode serve` (ISSUE-237): the kernel `SecretReader`
   * for the stored password, the HTTP transport, the scheduler and the log. Absent: no attach.
   */
  readonly server?: OpenCodeServerClientDeps
}

export class OpenCodeServerDriver implements ProviderDriver {
  readonly profile: ProviderProfile
  readonly transport = 'http-server' as const

  constructor(private readonly deps: OpenCodeServerDriverDeps) {
    this.profile = deps.record.profile
  }

  detect(): Promise<DetectResult> {
    return detectForDriver(this.deps.detection, {
      providerId: this.profile.id,
      binaries: this.profile.binaries
    })
  }

  /**
   * `opencode --help` (15 §2.3): `launch` opens only when the help lists `serve` AND S-031-3 has
   * verified a protection for it; today it never does.
   */
  async probe(install: InstalledProvider): Promise<ProviderCapabilities> {
    let help: string | null
    try {
      help = await this.readHelp(install)
    } catch {
      help = null
    }
    const serves = help !== null && helpOffers(help, SERVE_ARGS)
    return merge(this.deps.record.ceiling, {
      ...O1_ROW,
      launch: serves && SERVER_PROTECTION !== null
    })
  }

  /** FM-084: no verified protection, so nothing is spawned and no listener starts. */
  async launch(): Promise<DriverSession> {
    throw launchError(
      'could-not-start',
      'no verified protection for a Host-launched opencode serve (S-031-3): OpenCode launches through opencode acp'
    )
  }

  /**
   * 15 §4.6: `adopt` re-attaches a Host-launched server that survived a Host restart, by
   * `serverUrl` + session id. No such server is ever started (S-031-3), so there is none to
   * re-attach; a person-run server is `personRunServer` (ISSUE-237), with the stored password.
   */
  async adopt(ref: SessionRef): Promise<DriverSession | null> {
    void ref
    throw resumeError('no Host-launched opencode serve to re-attach (S-031-3)')
  }

  /**
   * 15 §4.6 row "Person-run server", 21 §2 4b: the client of the person's own `opencode serve` at
   * `url` (loopback only), which carries the stored password in the `Authorization` header and
   * nowhere else (ADR-017 item 3). Null when no server access is wired.
   */
  personRunServer(url: string): OpenCodeServerClient | null {
    const { server } = this.deps
    return server === undefined ? null : new OpenCodeServerClient({ owner: 'person', url }, server)
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

function launchError(cause: DriverLaunchError['cause'], detail: string): DriverLaunchError {
  return { cause, detail }
}

function resumeError(detail: string): DriverResumeError {
  return { reason: 'resume-error', detail }
}
