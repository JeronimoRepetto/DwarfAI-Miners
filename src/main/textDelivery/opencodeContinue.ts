import { spawn } from 'node:child_process'
import type { FsLike } from '../adapters/fsLike'
import { redactSecrets } from '../domain/redactSecrets'
import {
  describeProgramFailure,
  describeShimRefusal,
  resolveProgram
} from '../platform/cliDetection'
import { truncate } from '../../shared/truncate'
import type { TextDeliveryOutcome } from './port'

/**
 * Continuing an OpenCode session this panel (or a terminal) started with
 * `opencode run` — the second turn a launched session could not take
 * (#534), the OpenCode twin of codexResume.ts.
 *
 * `opencode run --session <id> --format json` was measured live on OpenCode
 * 1.18.31 (M4): the session id comes back unchanged, the prior context is
 * intact, the prompt is read from stdin, and `session.directory` never
 * changes. So this is the same shape as `codex-exec-resume` — a NEW process
 * on an existing session, addressed by the session id read from the store
 * rather than a guessed pid (#231 stays intact).
 *
 * Shared by every platform's TextDeliveryPort for the reason codexResume.ts
 * is: this tier spawns a CLI rather than talking to a window server, so
 * nothing about it differs per operating system. A detected `.cmd`/`.bat`
 * shim goes through `resolveProgram` (#193, #413) exactly as the Codex
 * tiers' does, and is run with no shell.
 *
 * The one thing that makes it unlike Codex's sibling: a concurrent
 * continuation is not refused. M6 measured two `--session` calls against the
 * same session, 1 s apart, both exiting 0 and racing — three assistant rows
 * for two prompts, one of them answering both combined. So the in-runtime
 * guard that keeps one continuation in flight per session (mirroring #457
 * in runtime.ts) is load-bearing here in a way it is only a safety margin
 * for Codex, whose own CLI at least refuses the second call outright.
 */

/**
 * How long a spawned continuation must survive before its message counts as
 * handed over (#534) — the OpenCode reading of CODEX_RESUME_START_WINDOW_MS.
 *
 * This is NOT a timeout, for the same reason it is not one for Codex:
 * `opencode run --session` blocks for the whole turn (M3/M4 measured 5-8 s
 * for a trivial one), so awaiting its exit would report a failure for a
 * message that worked. Instead the process is spawned, the message is
 * written to its stdin, stdin is closed, and the verdict is taken at this
 * mark: still running means the turn started, and a process gone by now
 * never began one.
 *
 * 2 s, the same window Codex's sibling uses: M8 shows the session row
 * appearing in the store about 1.3 s after spawn, well inside it, and every
 * failure this window has to catch — an unknown session id, argv parsing, a
 * folder OpenCode declines — happens before the first model call. Erring
 * long rather than short is deliberate: a window too short reports a ✓ for
 * a process that then died, while a window too long only costs the person a
 * moment watching the composer.
 */
export const OPENCODE_CONTINUE_START_WINDOW_MS = 2_000

/**
 * Bound on the stderr this tier reads back from a continued turn (#534),
 * mirroring CODEX_RESUME_STDERR_TAIL_BYTES.
 *
 * Read at all because a non-zero exit needs OpenCode's own words rather than
 * a guessed cause — see refusalReason below, which is deliberately narrower
 * than Codex's twin because M6 ruled one of Codex's two causes out for this
 * CLI. Bytes on the way in, characters on the way out
 * (OPENCODE_CONTINUE_STDERR_CHARS): the first stops an unbounded buffer, the
 * second stops an unbounded sentence, and `redactSecrets` runs between them.
 */
export const OPENCODE_CONTINUE_STDERR_TAIL_BYTES = 4 * 1024
/** How much of that tail a person actually reads; see the constant above. */
export const OPENCODE_CONTINUE_STDERR_CHARS = 300

export interface OpenCodeContinueInvocation {
  command: string
  args: string[]
  /** The session's own directory; OpenCode hangs from any other (M4). */
  cwd: string
  /** Written to the process's stdin, which is then closed. Never an argv element. */
  text: string
  startWindowMs: number
}

export interface OpenCodeContinueResult {
  /** True when the process was still alive once the start window elapsed. */
  running: boolean
  /**
   * Its exit code when it ended inside that window. Absent both when it
   * survived and when it ended by a signal, which carries no code to report.
   */
  exitCode?: number
  /**
   * When the process finally ended, for one that outlived the window (#534,
   * mirroring #457) — needed for the same reason: somebody has to know when
   * a turn ends before another continuation may start on the same session,
   * and the runner is the only thing holding the handle.
   *
   * Resolves and never rejects: this reports an ENDING, and a turn that
   * failed still ended. Absent for a runner that cannot see the end.
   */
  ended?: Promise<void>
  /**
   * A bounded, unredacted tail of what the process wrote to stderr before it
   * died inside the window.
   *
   * Raw here, exactly as CodexResumeResult.stderrTail is raw: redaction and
   * the display cap happen at the boundary this crosses, which is
   * `deliverViaOpenCodeContinue` below.
   */
  stderrTail?: string
}

export type OpenCodeContinueRunner = (
  invocation: OpenCodeContinueInvocation
) => Promise<OpenCodeContinueResult>

/**
 * Argv for one continued turn (#534, M4).
 *
 * No positional message and no `-m`/`--variant`: the prompt travels on
 * stdin alone (M9), and omitting a model flag keeps the session on the one
 * it already has rather than swapping it (M5 measured a swap works, but
 * nothing here asks for one — see OpenCodeContinueRequest's own comment).
 */
export function buildOpenCodeContinueArgs(sessionId: string): string[] {
  return ['run', '--session', sessionId, '--format', 'json']
}

/**
 * Spawn one continued turn and answer at the start window, never at its
 * exit — the OpenCode twin of runCodexResumeProcess.
 *
 * stdout is ignored: nothing reads a continued turn's output — the panel
 * reads the session's own store rows like every other OpenCode dwarf — and a
 * pipe nobody drains fills and blocks the turn it was meant to observe. The
 * process is left running on purpose; it outlives this promise, which is the
 * entire point of the start window.
 *
 * stderr is PIPED and drained the moment anything arrives, capped at
 * OPENCODE_CONTINUE_STDERR_TAIL_BYTES — the same shape #457 gave Codex's
 * sibling, for the same reason: an undrained pipe fills and blocks, and a
 * drained, bounded one cannot.
 *
 * The child's own exit is kept too, as `ended`, on the same terms
 * runCodexResumeProcess keeps it: the one signal that is both immediate and
 * certain about a turn this panel started.
 */
export function runOpenCodeContinueProcess(
  invocation: OpenCodeContinueInvocation
): Promise<OpenCodeContinueResult> {
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
    const settle = (result: OpenCodeContinueResult): void => {
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
      if (stderrTail.length >= OPENCODE_CONTINUE_STDERR_TAIL_BYTES) return
      stderrTail = (stderrTail + chunk).slice(-OPENCODE_CONTINUE_STDERR_TAIL_BYTES)
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
    // message held behind that session waiting out its bound for nothing.
    if (exited) endTurn()
  })
}

export interface OpenCodeContinueDeliveryOptions {
  sessionId: string
  /** The session's own directory, which is where its next turn is run. */
  cwd: string
  text: string
  /** Resolved through the CLI detection port; undefined means opencode was not found. */
  binaryPath: string | undefined
  startWindowMs?: number
  run: OpenCodeContinueRunner
  /**
   * The same `FsLike` CLI detection probes with (#413) — needed here to read
   * a `.cmd`/`.bat` shim for the program it points at, exactly as
   * `resolveProgram` needs one. Injected like `run`, so a test never touches
   * a real disk.
   */
  fs: FsLike
}

const NOT_FOUND =
  'The opencode binary could not be found, so the session could not be continued. ' +
  'Set OPENCODE_CLI_PATH to it.'

/** Names the path tried and why, rather than a fixed sentence (#502's precedent). */
function notStarted(binaryPath: string, cause: string): string {
  return `The opencode continue command could not be started: ${binaryPath} — ${cause}.`
}

const STOPPED_BY_SIGNAL =
  'OpenCode stopped straight away, so the turn never started and nothing was delivered.'

/**
 * Why a continued turn refused, in OpenCode's own words where it left any
 * (#534).
 *
 * Codex's twin names two candidate causes for a silent non-zero exit,
 * because #450 could not tell them apart. OpenCode is narrower: M6 measured
 * a concurrent `--session` call against a busy session and it was accepted,
 * not refused — the two calls raced rather than one exiting early — so "a
 * turn may already be running" is a cause this CLI was shown NOT to use for
 * a non-zero exit. What is left unmeasured is which failures DO produce one
 * (an unknown session id, most plausibly), so the honest sentence names the
 * uncertainty rather than asserting a specific cause evidence does not
 * support.
 *
 * `redactSecrets` first and `truncate` after, the order every other captured
 * tail in this app uses (#263). The person's own message is not involved at
 * any point — it went on stdin, and stderr is the child's own writing.
 */
function refusalReason(exitCode: number, stderrTail: string | undefined): string {
  const said = truncate(redactSecrets(stderrTail ?? ''), OPENCODE_CONTINUE_STDERR_CHARS).trim()
  const opening = `OpenCode stopped straight away (exit ${exitCode}), so nothing was delivered.`
  return said === ''
    ? `${opening} It said nothing about why: the session id may be one it no longer knows, ` +
        'or it could not start in that folder.'
    : `${opening} It said: ${said}`
}

/**
 * Continue one session with a message, mapping every failure mode to a
 * reason the panel can show — the OpenCode twin of deliverViaCodexResume.
 * Never rejects, and never echoes the message back.
 *
 * A `delivered: true` here means the message reached the session and its
 * turn began. That is a HAND-OVER and never a reaction — whether anything
 * acted on it is the store watcher's finding to make, and nothing on this
 * path may promote a marker past `delivered` (see the renderer's
 * reaction.ts).
 *
 * No version floor guards it: the measurement behind this channel is
 * OpenCode 1.18.31 and no older build has been tried, which is stated rather
 * than encoded because an unrecognised `--session` flag would fail loudly
 * inside the start window on its own.
 */
export async function deliverViaOpenCodeContinue(
  options: OpenCodeContinueDeliveryOptions
): Promise<TextDeliveryOutcome> {
  const binaryPath = options.binaryPath
  if (binaryPath === undefined) return { delivered: false, error: NOT_FOUND }

  const startWindowMs = options.startWindowMs ?? OPENCODE_CONTINUE_START_WINDOW_MS
  try {
    // Inside the try because reading a shim is a disk read that can fail like a
    // spawn can, and it fails the same way for the user here too (#413):
    // nothing continued, never a guess at what the shim would have run.
    const program = await resolveProgram(binaryPath, options.fs)
    if ('kind' in program) {
      return { delivered: false, error: notStarted(program.shimPath, describeShimRefusal(program)) }
    }
    const result = await options.run({
      command: program.command,
      args: [...program.args, ...buildOpenCodeContinueArgs(options.sessionId)],
      cwd: options.cwd,
      text: options.text,
      startWindowMs
    })
    if (result.running) {
      // The ending rides the outcome only when the runner could see one
      // (#534, mirroring #457). Absent stays absent: a caller that tracked a
      // turn it will never be told the end of would hold every later
      // message behind it until the wait ran out.
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
