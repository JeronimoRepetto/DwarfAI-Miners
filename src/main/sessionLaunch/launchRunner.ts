import { spawn } from 'node:child_process'
import type { AgentLaunchResult } from '../domain/types'
import type { CliDetector } from '../platform/cliDetection'
import type { Platform } from '../platform/platform'
import { buildRelayEnv } from '../textDelivery/relay'
import { buildClaudeLaunchArgs, prepareLaunchPrompt } from './launch'

/**
 * Running the launch: the spawn seam, and the mapping from every way it can go
 * wrong to a reason the panel can show.
 *
 * Like the relay this is platform-neutral — it spawns a CLI instead of talking
 * to a window server — so it is composed in the runtime rather than in
 * platformAdapters, and the only per-OS detail (how PATH is spelled) arrives as
 * a Platform parameter.
 */

/** Refusals and failures, phrased for the panel. */
const EMPTY_PROMPT = 'Type a prompt first.'
const NOT_INSTALLED = 'Claude Code is not installed on this machine.'
const COULD_NOT_START = 'Claude Code could not be started.'

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
 * The port as the runtime holds it: a folder and a prompt in, a verdict out.
 * Which CLI answers is decided behind this, not by the caller — Claude is the
 * only one wired today, and widening past it is gated on #78.
 */
export type SessionLauncher = (request: {
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
  const prompt = prepareLaunchPrompt(options.prompt)
  // Cheapest refusal first, so an empty box never costs a disk probe.
  if (prompt === '') return { launched: false, provider: 'none', error: EMPTY_PROMPT }

  const detection = await options.detector.detect('claude')
  if (!detection.installed || detection.path === undefined) {
    return {
      launched: false,
      provider: 'claude',
      error: detection.reason === undefined ? NOT_INSTALLED : `${NOT_INSTALLED} ${detection.reason}`
    }
  }

  try {
    await options.run({
      command: detection.path,
      args: buildClaudeLaunchArgs(),
      // The relay's env rule, for the relay's reason: a re-exec of `claude`
      // inside the child must reach the real binary rather than a shim that
      // happens to sit earlier on PATH.
      env: buildRelayEnv(options.env, detection.path, options.platform),
      cwd: options.minePath,
      stdin: prompt
    })
    return { launched: true, provider: 'claude' }
  } catch {
    return { launched: false, provider: 'claude', error: COULD_NOT_START }
  }
}
