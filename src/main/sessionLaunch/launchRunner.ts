import { spawn } from 'node:child_process'
import type { AgentLaunchResult, DwarfProvider } from '../domain/types'
import type { CliDetector } from '../platform/cliDetection'
import type { Platform } from '../platform/platform'
import { buildRelayEnv } from '../textDelivery/relay'
import { buildLaunchArgs, prepareLaunchPrompt } from './launch'

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
const NOT_INSTALLED = 'Claude Code is not installed on this machine.'
const COULD_NOT_START = 'Claude Code could not be started.'
const NO_INVOCATION = 'The panel has no way to start that agent.'

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
  /** Which CLI to start (#168). Refused by name when this engine has no argv for it. */
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
 * Start one Claude session in a mine's folder.
 *
 * Every failure becomes a `launched: false` verdict with a reason, never a
 * silent no-op — the discipline deliverViaRelay already holds. "Not installed"
 * is deliberately its own reason rather than being folded into "could not be
 * started": it is the one failure the user can actually do something about,
 * and detection (#91) already knows how to say why.
 *
 * A successful verdict says a process started and nothing more. No dwarf is
 * returned and none is invented: the poll discovers the session, on its own
 * schedule.
 */
export async function launchClaudeSession(
  options: ClaudeLaunchOptions
): Promise<AgentLaunchResult> {
  // Refused ahead of everything, because nothing about this machine or this
  // prompt could change it (#168): an argv this engine does not have is not a
  // failure the user can act on, and probing the disk for a binary there is
  // nothing to run would be work done to reach the same answer.
  const args = buildLaunchArgs(options.provider)
  if (args === null) {
    return { launched: false, provider: options.provider, error: NO_INVOCATION }
  }

  const prompt = prepareLaunchPrompt(options.prompt)
  // Cheapest refusal first, so an empty box never costs a disk probe.
  if (prompt === '') return { launched: false, provider: 'none', error: EMPTY_PROMPT }

  const detection = await options.detector.detect(options.provider)
  if (!detection.installed || detection.path === undefined) {
    return {
      launched: false,
      provider: options.provider,
      error: detection.reason === undefined ? NOT_INSTALLED : `${NOT_INSTALLED} ${detection.reason}`
    }
  }

  try {
    await options.run({
      command: detection.path,
      args,
      // The relay's env rule, for the relay's reason: a re-exec of `claude`
      // inside the child must reach the real binary rather than a shim that
      // happens to sit earlier on PATH.
      env: buildRelayEnv(options.env, detection.path, options.platform),
      cwd: options.minePath,
      stdin: prompt
    })
    return { launched: true, provider: options.provider }
  } catch {
    return { launched: false, provider: options.provider, error: COULD_NOT_START }
  }
}
