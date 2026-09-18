import { spawn } from 'node:child_process'
import type { FsLike } from '../adapters/fsLike'
import { codexTuningArgs, type LaunchTuning } from '../domain/launchTuning'
import { resolveProgram } from '../platform/cliDetection'
import type { TextDeliveryOutcome } from './port'

/**
 * Continuing a Codex thread this panel (or a terminal) started with
 * `codex exec` — the second turn a launched session could not take (#450).
 *
 * `codex exec [OPTIONS] resume <SESSION_ID> -` was measured live on Codex CLI
 * 0.153.4: the session id comes back unchanged, the prior context is intact,
 * the prompt is read from stdin, and Codex's own registry keeps ONE row whose
 * `source` stays `'exec'`. So this is a NEW channel rather than a widening of
 * the queue gate — `canQueueToCodexThread` still refuses an exec thread, and
 * still correctly (see providers/codex/queue.ts).
 *
 * Shared by every platform's TextDeliveryPort for the reason codexQueue.ts and
 * relayRunner.ts are: this tier spawns a CLI rather than talking to a window
 * server, so nothing about it differs per operating system. A detected
 * `.cmd`/`.bat` shim goes through `resolveProgram` (#193, #413) exactly as the
 * queue tier's does, and is run with no shell.
 *
 * The one thing that makes it unlike every other tier is how long it takes.
 */

/**
 * How long a spawned resume must survive before its message counts as handed
 * over (#450).
 *
 * This is NOT a timeout, and that difference is the whole design. `codex exec
 * resume` blocks for the entire model turn — 29 s measured for a trivial one,
 * minutes for a real one — so awaiting its exit would report a failure for a
 * message that worked, which is what CODEX_QUEUE_TIMEOUT_MS would have done at
 * 20 s. Instead the process is spawned, the message is written to its stdin,
 * stdin is closed, and the verdict is taken at this mark: still running means
 * the turn started, and a process gone by now never began one.
 *
 * 2 s because every failure this has to catch happens before the first model
 * call — argv clap refuses (exit 2), the thread store does not hold that id,
 * the folder is not one Codex will run in, the binary will not start — which
 * is argv parsing, a config read and a SQLite lookup. Erring long rather than
 * short is deliberate: a window too short reports a ✓ for a process that then
 * died, which is the exit-0-shaped lie #97 named, while a window too long only
 * costs the person a moment watching the composer.
 */
export const CODEX_RESUME_START_WINDOW_MS = 2_000

export interface CodexResumeInvocation {
  command: string
  args: string[]
  /** The mine the thread belongs to; Codex declines to run outside a Git repository. */
  cwd: string
  /** Written to the process's stdin, which is then closed. Never an argv element. */
  text: string
  startWindowMs: number
}

export interface CodexResumeResult {
  /** True when the process was still alive once the start window elapsed. */
  running: boolean
  /**
   * Its exit code when it ended inside that window. Absent both when it
   * survived and when it ended by a signal, which carries no code to report.
   */
  exitCode?: number
}

export type CodexResumeRunner = (invocation: CodexResumeInvocation) => Promise<CodexResumeResult>

/**
 * Argv for one resumed turn.
 *
 * The order is measured, not guessed: `codex exec resume <id> -s read-only -`
 * exits 2 with `unexpected argument '-s' found`, because the options belong to
 * `codex exec` and the parser stops reading them at the subcommand. So every
 * option goes BEFORE `resume`. This is the sibling of the trap
 * `buildCodexLaunchArgs` already records for a flag written after the prompt.
 *
 * `-` is the documented "instructions are read from stdin" positional, the
 * same one the opening launch passes, and it is what keeps the message off the
 * command line entirely (#437).
 *
 * AMENDED for #462 (was: "No options are passed today", when the only caller
 * was #450's plain resume). `deliverViaCodexResume` now passes
 * `codexTuningArgs(tuning)` here — the same builder `buildCodexLaunchArgs`
 * delegates to — so a tuned resume's `-m`/`-c model_reasoning_effort=` pair
 * lands in the one place a caller could get catastrophically wrong: putting
 * either flag after the subcommand. `--skip-git-repo-check` stays out for the
 * reason the launch keeps it out — overriding Codex's own refusal to run
 * outside a repository would be this panel making a safety decision inside
 * somebody's folder.
 */
export function buildCodexResumeArgs(threadId: string, options: readonly string[] = []): string[] {
  return ['exec', ...options, 'resume', threadId, '-']
}

/**
 * Spawn one resumed turn and answer at the start window, never at its exit.
 *
 * stdout and stderr are ignored rather than captured: nothing reads a resumed
 * turn's output — the panel reads the thread's rollout like every other Codex
 * session — and a pipe nobody drains fills and blocks the turn it was meant to
 * observe. The process is left running on purpose; it outlives this promise,
 * which is the entire point of the start window.
 */
export function runCodexResumeProcess(
  invocation: CodexResumeInvocation
): Promise<CodexResumeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore']
    })
    let settled = false
    const settle = (result: CodexResumeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => settle({ running: true }), invocation.startWindowMs)
    // The app must not be held open by this wait: the verdict is a moment, and
    // the process it is about is expected to outlive it either way.
    timer.unref?.()
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error) // the binary could not be started at all
    })
    child.on('exit', (code) =>
      settle(code === null ? { running: false } : { running: false, exitCode: code })
    )
    // A process that died before reading its stdin makes this write fail with
    // EPIPE, which is the exit above reported twice rather than a second fault.
    child.stdin?.on('error', () => {})
    child.stdin?.end(invocation.text)
  })
}

export interface CodexResumeDeliveryOptions {
  threadId: string
  /** The mine the thread belongs to, which is where its next turn is run. */
  cwd: string
  text: string
  /** Resolved through the CLI detection port; undefined means codex was not found. */
  binaryPath: string | undefined
  startWindowMs?: number
  run: CodexResumeRunner
  /**
   * The same `FsLike` CLI detection probes with (#413) — needed here to read a
   * `.cmd`/`.bat` shim for the program it points at, exactly as `resolveProgram`
   * needs one. Injected like `run`, so a test never touches a real disk.
   */
  fs: FsLike
  /**
   * What this resumed turn should carry (#462) — already resolved by the
   * runtime's resumeTuning(launch, observed). Absent or `{}` both produce the
   * exact argv this channel had before this issue: `codexTuningArgs({})` is
   * `[]`, so the spread below adds nothing.
   */
  tuning?: LaunchTuning
}

const NOT_FOUND =
  'The codex binary could not be found, so the session could not be resumed. ' +
  'Set CODEX_CLI_PATH to it.'
const NOT_STARTED = 'The codex resume command could not be started.'
const STOPPED_BY_SIGNAL =
  'Codex stopped straight away, so the turn never started and nothing was delivered.'

/**
 * Resume one thread with a message, mapping every failure mode to a reason the
 * panel can show. Never rejects, and never echoes the message back — the
 * outcome carries a verdict and a sentence, and there is no field a payload
 * could travel in.
 *
 * A `delivered: true` here means the message reached the session and its turn
 * began. That is a HAND-OVER and never a reaction, on exactly the terms the
 * queue tier's ✓ is one: whether anything acted on it is the transcript
 * watcher's finding to make, and nothing on this path may promote a marker past
 * `delivered` (see the renderer's reaction.ts).
 *
 * No version floor guards it, unlike the queue (#97), because the failure
 * shapes are opposite. A queue that accepts an item and never drains it reports
 * exit 0 and loses the message silently; a Codex build with no `exec resume`
 * refuses the argv outright and dies inside the start window, so the person
 * reads a refusal rather than a ✓ for nothing. The measurement behind this
 * channel is 0.153.4 and no older build has been tried — which is stated rather
 * than encoded, because here the unproven case fails loudly on its own.
 */
export async function deliverViaCodexResume(
  options: CodexResumeDeliveryOptions
): Promise<TextDeliveryOutcome> {
  const binaryPath = options.binaryPath
  if (binaryPath === undefined) return { delivered: false, error: NOT_FOUND }

  const startWindowMs = options.startWindowMs ?? CODEX_RESUME_START_WINDOW_MS
  try {
    // Inside the try because reading a shim is a disk read that can fail like a
    // spawn can, and it fails the same way for the user here too (#413):
    // nothing resumed, never a guess at what the shim would have run.
    const program = await resolveProgram(binaryPath, options.fs)
    if (program === undefined) return { delivered: false, error: NOT_STARTED }
    const result = await options.run({
      command: program.command,
      args: [
        ...program.args,
        ...buildCodexResumeArgs(options.threadId, codexTuningArgs(options.tuning ?? {}))
      ],
      cwd: options.cwd,
      text: options.text,
      startWindowMs
    })
    if (result.running) return { delivered: true }
    // Exit 0 inside the window is a turn short enough to have finished, which
    // is the message delivered and answered rather than a failure.
    if (result.exitCode === 0) return { delivered: true }
    if (result.exitCode === undefined) return { delivered: false, error: STOPPED_BY_SIGNAL }
    return {
      delivered: false,
      error:
        `Codex stopped straight away (exit ${result.exitCode}), so nothing was delivered. ` +
        'It may no longer know that session.'
    }
  } catch {
    return { delivered: false, error: NOT_STARTED }
  }
}
