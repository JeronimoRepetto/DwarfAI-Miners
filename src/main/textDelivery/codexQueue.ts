import { execFile } from 'node:child_process'
import type { FsLike } from '../adapters/fsLike'
import { resolveProgram } from '../platform/cliDetection'
import type { TextDeliveryOutcome } from './port'

/**
 * Handing one message to a Codex thread's own message queue (#97).
 *
 * Shared by every platform's TextDeliveryPort, exactly as relayRunner.ts is and
 * for the same reason: this tier spawns a CLI rather than talking to a window
 * server, so nothing about it differs per operating system. There is no PATH
 * separator to get right either — the binary is addressed in full, resolved
 * through the CLI detection port (#91) rather than a second hardcoded path.
 *
 * A detected `.cmd`/`.bat` shim is resolved to the program it names and run
 * directly (`resolveProgram` in platform/cliDetection.ts, #193) rather than
 * refused (#413). The launcher already had to solve this exact problem — Node
 * cannot spawn a batch shim without a shell — and this tier needs the
 * identical resolution for its own reason: the message is an argv element a
 * shell would re-parse, and `resolveProgram`'s spawn never goes through one
 * either. One function shared by both callers, so they cannot drift the way
 * `isShellShim` (launch.ts) and this file's own now-deleted copy already had.
 *
 * A ✓ from here means the item is persisted on the thread's queue, and the
 * thread drains it at its next idle boundary. That is a hand-over, never a
 * reaction: see the delivered-versus-reacted rule in shared/contracts.ts.
 */

/**
 * How long the queue call may run. Not configurable, and deliberately: this is
 * a local process submitting one RPC to a SQLite-backed store, measured in
 * milliseconds — unlike SENDTEXT_TIMEOUT_S, which covers a whole `claude -p`
 * model turn and genuinely varies by machine and model. A number nobody needs
 * to tune does not belong in the configuration surface.
 */
export const CODEX_QUEUE_TIMEOUT_MS = 20_000

export interface CodexQueueInvocation {
  command: string
  args: string[]
  timeoutMs: number
}

export interface CodexQueueResult {
  exitCode: number
  timedOut: boolean
}

export type CodexQueueRunner = (invocation: CodexQueueInvocation) => Promise<CodexQueueResult>

/**
 * Argv for one queue submission. `--thread` takes "Session UUID or exact
 * session name" and the two forms resolve differently: a NAME requires an
 * active session, a UUID is a thread-store lookup keyed on the rollout. The
 * UUID is what the provider already holds and the form that needs the session
 * attached to nothing, so it is the only one used.
 *
 * The message travels as its own argv element, never inside a command line, so
 * quotes, newlines and shell metacharacters in a payload are just bytes.
 */
export function buildCodexQueueArgs(threadId: string, text: string): string[] {
  return ['queue', '--thread', threadId, '--message', text]
}

export function runCodexQueueProcess(invocation: CodexQueueInvocation): Promise<CodexQueueResult> {
  return new Promise((resolve, reject) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        timeout: invocation.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error) => {
        if (error === null) {
          resolve({ exitCode: 0, timedOut: false })
          return
        }
        // execFile reports a timeout kill through `killed`, with no exit code.
        if (error.killed === true) {
          resolve({ exitCode: 1, timedOut: true })
          return
        }
        if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, timedOut: false })
          return
        }
        reject(error) // the binary could not be started at all
      }
    )
  })
}

export interface CodexQueueDeliveryOptions {
  threadId: string
  text: string
  /** Resolved through the CLI detection port; undefined means codex was not found. */
  binaryPath: string | undefined
  timeoutMs?: number
  run: CodexQueueRunner
  /**
   * The same `FsLike` CLI detection probes with (#413) — needed here too, to
   * read a `.cmd`/`.bat` shim for the program it points at, exactly as
   * `resolveProgram` needs one. Injected like `run`, so a test never touches a
   * real disk and never resolves a real shim on the machine running it.
   */
  fs: FsLike
}

const NOT_FOUND =
  'The codex binary could not be found, so there is nowhere to queue the message. ' +
  'Set CODEX_CLI_PATH to it.'
const UNKNOWN_THREAD = 'Codex no longer knows that session, so the message was not queued.'
const NOT_STARTED = 'The codex queue command could not be started.'

/**
 * Queue one message on a thread, mapping every failure mode to a reason the
 * panel can show. Never rejects, and never echoes the message back — the
 * outcome carries a verdict and a sentence, and there is no field a payload
 * could travel in.
 *
 * The exit codes are the measured ones: 0 with `Queued message <id> for thread
 * <id>.`, and 1 with a one-line thread-store error for an id the store does not
 * hold. Exit 1 is named as "session gone" rather than left generic because that
 * is the only thing it has been observed to mean, and it is the one a user can
 * act on.
 *
 * A `.cmd`/`.bat` shim used to be refused outright here (naming CODEX_CLI_PATH,
 * an exit no packaged user could take) on the reasoning that a shell would
 * re-parse the message. #413 removed that refusal: `resolveProgram` reads the
 * shim for the program it actually names and this still calls `execFile` on
 * THAT program with no shell, so the message stays its own argv element —
 * exactly the property the old refusal existed to protect, just reached a
 * different way. A shim that cannot be read or names nothing runnable still
 * fails closed, with this same NOT_STARTED sentence, never a guess.
 */
export async function deliverViaCodexQueue(
  options: CodexQueueDeliveryOptions
): Promise<TextDeliveryOutcome> {
  const binaryPath = options.binaryPath
  if (binaryPath === undefined) return { delivered: false, error: NOT_FOUND }

  const timeoutMs = options.timeoutMs ?? CODEX_QUEUE_TIMEOUT_MS
  try {
    // Inside the try because reading a shim is a disk read that can fail like
    // a spawn can, and it fails the same way for the user here too (#413):
    // nothing queued, never a guess at what the shim would have run.
    const program = await resolveProgram(binaryPath, options.fs)
    if (program === undefined) return { delivered: false, error: NOT_STARTED }
    const result = await options.run({
      command: program.command,
      args: [...program.args, ...buildCodexQueueArgs(options.threadId, options.text)],
      timeoutMs
    })
    if (result.timedOut) {
      return {
        delivered: false,
        error: `Queueing the message timed out after ${Math.round(timeoutMs / 1_000)}s.`
      }
    }
    if (result.exitCode === 1) return { delivered: false, error: UNKNOWN_THREAD }
    if (result.exitCode !== 0) {
      return {
        delivered: false,
        error: `The message could not be queued (exit ${result.exitCode}).`
      }
    }
    return { delivered: true }
  } catch {
    return { delivered: false, error: NOT_STARTED }
  }
}
