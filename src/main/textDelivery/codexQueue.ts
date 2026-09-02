import { execFile } from 'node:child_process'
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

/**
 * Whether this path is a Windows shell shim rather than a real executable.
 *
 * An npm-global `codex` on Windows is a `.cmd`, and Node refuses to spawn one
 * without a shell. Handing the command line to cmd.exe would let it re-parse
 * the payload: `%USERPROFILE%` would expand a real home path INTO the message,
 * and a stray quote could end the argument early. So a shim is refused with the
 * remedy instead — the same line relay.ts draws when it says the worst a
 * payload may achieve is reaching the wrong session, never a command running.
 */
export function isShellShimPath(binaryPath: string): boolean {
  const lower = binaryPath.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat')
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
}

const NOT_FOUND =
  'The codex binary could not be found, so there is nowhere to queue the message. ' +
  'Set CODEX_CLI_PATH to it.'
const SHIM_REFUSED =
  'The detected codex is a .cmd/.bat shim, which cannot be run safely with a message payload. ' +
  'Set CODEX_CLI_PATH to the real executable.'
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
 */
export async function deliverViaCodexQueue(
  options: CodexQueueDeliveryOptions
): Promise<TextDeliveryOutcome> {
  const command = options.binaryPath
  if (command === undefined) return { delivered: false, error: NOT_FOUND }
  if (isShellShimPath(command)) return { delivered: false, error: SHIM_REFUSED }

  const timeoutMs = options.timeoutMs ?? CODEX_QUEUE_TIMEOUT_MS
  try {
    const result = await options.run({
      command,
      args: buildCodexQueueArgs(options.threadId, options.text),
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
