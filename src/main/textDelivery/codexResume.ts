import { spawn } from 'node:child_process'
import type { FsLike } from '../adapters/fsLike'
import { codexTuningArgs, type LaunchTuning } from '../domain/launchTuning'
import { redactSecrets } from '../domain/redactSecrets'
import {
  describeProgramFailure,
  describeShimRefusal,
  resolveProgram
} from '../platform/cliDetection'
import { truncate } from '../../shared/truncate'
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

/**
 * Bound on the stderr this tier reads back from a resumed turn (#457).
 *
 * Read at all because exit 1 has at least two causes and this app cannot tell
 * them apart on its own: the thread id is one Codex no longer knows (#450's
 * reading), or a turn is already running on that thread (measured 2026-09-18).
 * Rather than name one and be wrong half the time, the CLI's own words are
 * quoted — and quoting means bounding, because a chatty refusal must not grow
 * a sentence a person has to read without limit.
 *
 * Bytes on the way in, characters on the way out (CODEX_RESUME_STDERR_CHARS):
 * the first stops an unbounded buffer, the second stops an unbounded sentence,
 * and `redactSecrets` runs between them. Same order as the launch failure's
 * own tail (#263), and for the same reason.
 */
export const CODEX_RESUME_STDERR_TAIL_BYTES = 4 * 1024
/** How much of that tail a person actually reads; see the constant above. */
export const CODEX_RESUME_STDERR_CHARS = 300

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
  /**
   * When the process finally ended, for one that outlived the window (#457).
   *
   * The whole point of the window is that this tier answers long before its
   * act finishes — but somebody still has to know when the turn ended, because
   * Codex refuses a second turn on a thread that is running one. So the runner
   * keeps the handle it already has and says so here. Resolves and never
   * rejects: this reports an ENDING, and a turn that failed still ended.
   *
   * Absent for a runner that cannot see the end. That is a true statement
   * about the runner, not a gap: the caller then tracks nothing rather than
   * waiting on something it will never be told about.
   */
  ended?: Promise<void>
  /**
   * A bounded, unredacted tail of what the process wrote to stderr before it
   * died inside the window (#457) — the CLI's own words for why it refused.
   *
   * Raw here, exactly as `LaunchFailure.stderrTail` is raw: redaction and the
   * display cap happen at the boundary this crosses, which is
   * `deliverViaCodexResume` below. Absent when it wrote nothing, or when the
   * runner does not capture stderr at all.
   */
  stderrTail?: string
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
 * `deliverViaCodexResume` passes `codexTuningArgs(tuning)` here (#462) — the
 * same builder `buildCodexLaunchArgs` delegates to — so a tuned resume's
 * `-m`/`-c model_reasoning_effort=` pair lands in the one place a caller
 * could get catastrophically wrong: putting either flag after the
 * subcommand. `--skip-git-repo-check` stays out for the reason the launch
 * keeps it out — overriding Codex's own refusal to run outside a repository
 * would be this panel making a safety decision inside somebody's folder.
 */
export function buildCodexResumeArgs(threadId: string, options: readonly string[] = []): string[] {
  return ['exec', ...options, 'resume', threadId, '-']
}

/**
 * Spawn one resumed turn and answer at the start window, never at its exit.
 *
 * stdout is ignored: nothing reads a resumed turn's output — the panel reads
 * the thread's rollout like every other Codex session — and a pipe nobody
 * drains fills and blocks the turn it was meant to observe. The process is
 * left running on purpose; it outlives this promise, which is the entire point
 * of the start window.
 *
 * stderr is PIPED since #457, and drained the moment anything arrives, capped
 * at CODEX_RESUME_STDERR_TAIL_BYTES. That is the same objection answered
 * rather than ignored: an undrained pipe fills and blocks, and a drained,
 * bounded one cannot. What it buys is the difference between the two causes of
 * exit 1, which this app was naming wrongly half the time.
 *
 * The child's own exit is kept too, as `ended`. It is the one signal that is
 * both immediate and certain about a turn this panel started — the rollout
 * scan lags it by a poll in both directions — and keeping a listener on a
 * child that was always going to outlive this promise costs nothing it was not
 * already costing.
 */
export function runCodexResumeProcess(
  invocation: CodexResumeInvocation
): Promise<CodexResumeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let settled = false
    let stderrTail = ''
    let exited = false
    // Resolved by the child's own exit, whenever that is — minutes after this
    // promise has answered, for an ordinary turn. Never rejected: an ending is
    // an ending however the process got there.
    let endTurn = (): void => {}
    const ended = new Promise<void>((resolveEnd) => {
      endTurn = resolveEnd
    })
    const settle = (result: CodexResumeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(
      // `ended` only for a process that survived: one already gone has no
      // ending left to report, and the caller would be waiting on a turn that
      // is over.
      () => settle({ running: true, ended }),
      invocation.startWindowMs
    )
    // The app must not be held open by this wait: the verdict is a moment, and
    // the process it is about is expected to outlive it either way.
    timer.unref?.()
    child.stdout?.resume() // drained and discarded; see the doc comment above
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderrTail.length >= CODEX_RESUME_STDERR_TAIL_BYTES) return
      stderrTail = (stderrTail + chunk).slice(-CODEX_RESUME_STDERR_TAIL_BYTES)
    })
    // Errors on either pipe are the exit reported twice, exactly as stdin's
    // EPIPE below is: a stream that broke belongs to a process that is going.
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error) // the binary could not be started at all
    })
    child.on('exit', (code) => {
      exited = true
      endTurn()
      settle({
        running: false,
        ...(code === null ? {} : { exitCode: code }),
        ...(stderrTail === '' ? {} : { stderrTail })
      })
    })
    // A process that died before reading its stdin makes this write fail with
    // EPIPE, which is the exit above reported twice rather than a second fault.
    child.stdin?.on('error', () => {})
    child.stdin?.end(invocation.text)
    // A child that had already exited before this listener was attached would
    // otherwise leave `ended` pending for the rest of the run, and every
    // message held behind that thread waiting out its bound for nothing.
    if (exited) endTurn()
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

/** Names the path tried and why, rather than a fixed sentence (#502). */
function notStarted(binaryPath: string, cause: string): string {
  return `The codex resume command could not be started: ${binaryPath} — ${cause}.`
}

const STOPPED_BY_SIGNAL =
  'Codex stopped straight away, so the turn never started and nothing was delivered.'

/**
 * Why a resumed turn refused, in Codex's own words where it left any (#457).
 *
 * #450 had ONE explanation for a non-zero exit and stated it as fact: "it may
 * no longer know that session". The 2026-09-18 measurement found a second — a
 * turn already running on that thread — and stderr was being discarded, so
 * this tier could not tell them apart and named the wrong one half the time.
 *
 * The fix is not a better guess. Codex's own stderr is quoted when there is
 * any, because the CLI knows which refusal it made and this app does not; and
 * when there is none, BOTH causes are named rather than one, which is the
 * honest reading of an exit code that could be either. What never happens is
 * this app asserting a cause on evidence it has not got.
 *
 * `redactSecrets` first and `truncate` after, the order the launch failure's
 * own tail uses (#263): nothing a CLI wrote to explain itself may reach a
 * person's screen unredacted, and nothing may grow without bound. The person's
 * own message is not involved at any point — it went on stdin, and stderr is
 * the child's own writing.
 */
function refusalReason(exitCode: number, stderrTail: string | undefined): string {
  const said = truncate(redactSecrets(stderrTail ?? ''), CODEX_RESUME_STDERR_CHARS).trim()
  const opening = `Codex stopped straight away (exit ${exitCode}), so nothing was delivered.`
  return said === ''
    ? `${opening} It said nothing about why: a turn may already be running on that session, ` +
        'or it may no longer know it.'
    : `${opening} It said: ${said}`
}

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
    if ('kind' in program) {
      return { delivered: false, error: notStarted(program.shimPath, describeShimRefusal(program)) }
    }
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
    if (result.running) {
      // The ending rides the outcome only when the runner could see one
      // (#457). Absent stays absent: a caller that tracked a turn it will
      // never be told the end of would hold every later message behind it
      // until the wait ran out.
      return { delivered: true, ...(result.ended === undefined ? {} : { turnEnded: result.ended }) }
    }
    // Exit 0 inside the window is a turn short enough to have finished, which
    // is the message delivered and answered rather than a failure.
    if (result.exitCode === 0) return { delivered: true }
    if (result.exitCode === undefined) return { delivered: false, error: STOPPED_BY_SIGNAL }
    return { delivered: false, error: refusalReason(result.exitCode, result.stderrTail) }
  } catch (error) {
    return { delivered: false, error: notStarted(binaryPath, describeProgramFailure(error)) }
  }
}
