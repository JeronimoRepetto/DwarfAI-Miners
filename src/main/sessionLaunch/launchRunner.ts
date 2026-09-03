import { spawn } from 'node:child_process'
import type { AgentLaunchResult, DwarfProvider } from '../domain/types'
import type { CliDetector } from '../platform/cliDetection'
import type { Platform } from '../platform/platform'
import { buildRelayEnv } from '../textDelivery/relay'
import { buildLaunchArgs, isShellShim, prepareLaunchPrompt } from './launch'

/**
 * Running the launch: the spawn seam, and the mapping from every way it can go
 * wrong to a reason the panel can show.
 *
 * Like the relay this is platform-neutral — it spawns a CLI instead of talking
 * to a window server — so it is composed in the runtime rather than in
 * platformAdapters, and the only per-OS detail (how PATH is spelled) arrives as
 * a Platform parameter.
 */

/** Refusals and failures, phrased for the panel. Fixed copy, and never a path. */
const EMPTY_PROMPT = 'Type a prompt first.'

/**
 * What each CLI is called when the panel has to name it.
 *
 * Per provider rather than one string, because these are the sentences a user
 * acts on: "Claude Code is not installed" shown for a Codex chip would send
 * somebody to install the wrong program at the one moment the message was
 * supposed to help (#168).
 */
const PRODUCT_NAME: Record<DwarfProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI'
}

/**
 * The config key that reaches an install this launcher cannot spawn.
 *
 * Named in the refusal because it is the only thing the user can do about it,
 * and it is a setting's name rather than a path — so it says nothing about this
 * machine's filesystem (docs/privacy.md, #59).
 */
const CLI_PATH_SETTING: Record<DwarfProvider, string> = {
  claude: 'CLAUDE_CLI_PATH',
  codex: 'CODEX_CLI_PATH'
}

function notInstalled(provider: DwarfProvider): string {
  return `${PRODUCT_NAME[provider]} is not installed on this machine.`
}

function couldNotStart(provider: DwarfProvider): string {
  return `${PRODUCT_NAME[provider]} could not be started.`
}

/** See `isShellShim`: a batch shim needs a shell, and a shell re-parses the payload. */
function shimRefusal(provider: DwarfProvider): string {
  return (
    `${PRODUCT_NAME[provider]} is installed as a shell shim the panel cannot start directly. ` +
    `Set ${CLI_PATH_SETTING[provider]} to the real executable.`
  )
}

export interface LaunchInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** The mine's folder. This, and nothing else, is what puts the new dwarf in the right mine. */
  cwd: string
  /** The first prompt, written to the child's stdin and never placed in argv. */
  stdin: string
}

/** Resolves once the process is running; rejects when it could not be started at all. */
export type LaunchRunner = (invocation: LaunchInvocation) => Promise<void>

/**
 * The port as the runtime holds it: a provider, a folder and a prompt in, a
 * verdict out.
 *
 * The provider is the caller's now (#168). It used to be decided behind this
 * port — "Claude is the only one wired today" — which meant the chip a user
 * pressed could not reach the engine at all, and every launch was a Claude one
 * whatever the panel said. Which CLIs this port can actually honour is still
 * the engine's answer, and it refuses the rest by name rather than substituting.
 */
export type SessionLauncher = (request: {
  provider: DwarfProvider
  minePath: string
  prompt: string
}) => Promise<AgentLaunchResult>

/**
 * Start the session and let go of it.
 *
 * Detached and unref'd so the agent outlives the panel: the panel is an
 * observer of sessions, and one that died whenever the tray icon quit would be
 * a worse thing than what a terminal already gives the user. stdin is the
 * prompt's only transport and is closed straight after writing — the child then
 * has no stream anyone here reads, which is also why the other two are ignored
 * rather than piped: an unread pipe fills and stalls the child.
 */
export function runLaunchProcess(invocation: LaunchInvocation): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      // A child that exits before reading breaks the pipe. That is its own
      // business by then — the process did start — but an unhandled EPIPE on
      // this stream would take the whole main process down with it.
      child.stdin?.on('error', () => {})
      child.stdin?.end(invocation.stdin)
      child.unref()
      resolve()
    })
  })
}

export interface ClaudeLaunchOptions {
  /** Which CLI to start (#168). Its argv comes from `buildLaunchArgs`. */
  provider: DwarfProvider
  /** The mine's path, resolved by the caller — never a path the renderer supplied. */
  minePath: string
  prompt: string
  detector: CliDetector
  env: NodeJS.ProcessEnv
  platform: Platform
  run: LaunchRunner
}

/**
 * Start one DETACHED session in a mine's folder, for whichever CLI was chosen.
 *
 * Detached is the whole of what this function does, and since #168 it is what a
 * Codex launch IS: Codex has no held-session engine in this app, so the only
 * shape available to it is start-and-let-go, with the ordinary poll discovering
 * the session afterwards through Codex's own rollout storage. Claude can be
 * launched either way; the held route lives in `heldSessionRegistry`.
 *
 * Every failure becomes a `launched: false` verdict with a reason, never a
 * silent no-op — the discipline deliverViaRelay already holds. "Not installed"
 * is deliberately its own reason rather than being folded into "could not be
 * started": it is the one failure the user can actually do something about,
 * and detection (#91) already knows how to say why. The shim refusal below is
 * the second of that kind, and names the setting that fixes it.
 *
 * A successful verdict says a process started and nothing more. No dwarf is
 * returned and none is invented: the poll discovers the session, on its own
 * schedule.
 */
export async function launchClaudeSession(
  options: ClaudeLaunchOptions
): Promise<AgentLaunchResult> {
  const prompt = prepareLaunchPrompt(options.prompt)
  // Cheapest refusal first, so an empty box never costs a disk probe.
  if (prompt === '') return { launched: false, provider: 'none', error: EMPTY_PROMPT }

  const detection = await options.detector.detect(options.provider)
  if (!detection.installed || detection.path === undefined) {
    const reason = notInstalled(options.provider)
    return {
      launched: false,
      provider: options.provider,
      error: detection.reason === undefined ? reason : `${reason} ${detection.reason}`
    }
  }

  // Detection found something that cannot be spawned without a shell, and a
  // shell would re-parse the payload. Refused with the setting that reaches the
  // real binary rather than left to fail as an opaque EINVAL (#168).
  if (isShellShim(detection.path)) {
    return { launched: false, provider: options.provider, error: shimRefusal(options.provider) }
  }

  try {
    await options.run({
      command: detection.path,
      args: buildLaunchArgs(options.provider),
      // The relay's env rule, for the relay's reason: a re-exec of the CLI
      // inside the child must reach the real binary rather than a shim that
      // happens to sit earlier on PATH.
      env: buildRelayEnv(options.env, detection.path, options.platform),
      cwd: options.minePath,
      stdin: prompt
    })
    return { launched: true, provider: options.provider }
  } catch {
    return { launched: false, provider: options.provider, error: couldNotStart(options.provider) }
  }
}
