import { execFile } from 'node:child_process'
import type { Platform } from '../platform/platform'
import type { TextDeliveryOutcome } from './port'
import {
  buildRelayArgs,
  buildRelayEnv,
  buildRelayInstruction,
  resolveClaudeBinaryPath
} from './relay'

/**
 * Running the `claude -p` relay turn. Shared by every platform's
 * TextDeliveryPort: the relay is the one delivery tier that is not
 * platform-specific — it spawns a CLI rather than talking to a window server —
 * so only the binary path and the PATH separator differ (see relay.ts), and
 * the verdict mapping below is identical everywhere.
 */

export interface RelayInvocation {
  command: string
  args: string[]
  /**
   * The courier instruction, written to the child's stdin and never placed in
   * argv (#437) — the same field, for the same reason, that
   * `LaunchInvocation.stdin` has carried the first prompt since #86.
   *
   * It used to be `args[1]`, the positional prompt after `-p`, which made
   * Windows' 32,767-character command line the bound on a MESSAGE and cost the
   * whole app a 15,359-character ceiling (#431). A stream has no such bound;
   * what a long instruction costs here is TIME, and `timeoutMs` is what bounds
   * that.
   */
  instruction: string
  env: NodeJS.ProcessEnv
  cwd: string
  timeoutMs: number
}

export interface RelayResult {
  exitCode: number
  timedOut: boolean
}

/**
 * The courier's per-character time allowance (#439), on top of the configured
 * base (`SENDTEXT_TIMEOUT_S`, unchanged in meaning).
 *
 * The relay is a whole model turn — `claude -p` reads the instruction, then
 * calls `SendMessage` and exits — so its duration grows with the instruction,
 * and a fixed timeout eventually kills a turn whose only remaining work was to
 * exit. Two real turns, measured against the relay model this app runs `claude
 * -p` on (haiku by default), pin the rate:
 *
 *   characters | turn time
 *   -----------|----------
 *          200 |      6.4s
 *       40,000 |      155s
 *
 * (155 − 6.4) s ÷ (40,000 − 200) chars ≈ 3.73 ms of turn time per character —
 * the measured rate. This budgets 5 ms/char, comfortably above it rather than
 * pinned to it, because a turn sized exactly to the measurement has no room
 * for a slower run: a busier machine, or a pricier model swapped into
 * `SENDTEXT_RELAY_MODEL`. At 5 ms/char the measured 40,000-character/155s turn
 * gets a 200s allowance on top of the base — a comfortable margin over what
 * was actually measured, not a bound pared to it.
 */
export const RELAY_MS_PER_CHAR = 5

/**
 * The courier's full time budget for one relay turn (#439): the configured
 * base plus RELAY_MS_PER_CHAR for every character the instruction carries, so
 * a message long enough to make the turn run for a while is not killed
 * mid-exit. Pure so the curve is unit-tested rather than eyeballed, at four
 * points: 200 and 40,000 (the two measurements above), 15,359
 * (MAX_CODEX_QUEUE_TEXT_CHARS, contracts.ts — this route has no such ceiling
 * of its own, but the number is already a familiar one in this codebase), and
 * 250,000 (MAX_DWARF_TEXT_CHARS, the wire's own sanity ceiling and the longest
 * message this function is ever asked to time — see docs/guide.md for what
 * that budget comes to).
 */
export function relayTimeoutMsFor(baseMs: number, textLength: number): number {
  return baseMs + textLength * RELAY_MS_PER_CHAR
}

export type RelayRunner = (invocation: RelayInvocation) => Promise<RelayResult>

/**
 * The slice of the spawned child this runner touches (#437) — its stdin, and
 * nothing else. `execFile` reads stdout and stderr for us, and the relay reads
 * neither: its verdict is the exit code.
 */
export interface RelayChild {
  stdin: {
    on(event: 'error', listener: () => void): unknown
    end(chunk: string, encoding: BufferEncoding): unknown
  } | null
}

/**
 * `execFile`'s shape as the relay needs it, so a test can assert the exact
 * spawn without starting a process — the seam `runLaunchProcess` has held for
 * the same reason since #193.
 */
export type RelayExecFile = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    timeout: number
    windowsHide: boolean
    maxBuffer: number
  },
  callback: (error: (Error & { killed?: boolean; code?: number | string }) | null) => void
) => RelayChild

/** The real one. Node's own `execFile` satisfies `RelayExecFile` through this. */
const nodeExecFile: RelayExecFile = (command, args, options, callback) =>
  execFile(command, [...args], options, (error) => callback(error))

/**
 * Run one relay turn, with the instruction on the child's stdin (#437).
 *
 * stdin is CLOSED straight after the write, and that is not tidiness: `claude
 * -p` with no positional prompt reads its prompt from stdin until end of
 * stream, so a stream left open is a turn that never starts. `end` rather than
 * `write` is what says so.
 *
 * The verdict mapping below is unchanged, and `neverStarted` still hangs off
 * the reject branch alone — see `deliverViaRelay`.
 */
export function runRelayProcess(
  invocation: RelayInvocation,
  execFileProcess: RelayExecFile = nodeExecFile
): Promise<RelayResult> {
  return new Promise((resolve, reject) => {
    const child = execFileProcess(
      invocation.command,
      invocation.args,
      {
        cwd: invocation.cwd,
        env: invocation.env,
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
    // A child that exits before reading breaks the pipe. That is its own
    // business by then — the callback above is what reports the turn — but an
    // unhandled EPIPE on this stream would take the whole main process with it,
    // exactly as it would on a launch (`runLaunchProcess`).
    child.stdin?.on('error', () => {})
    child.stdin?.end(invocation.instruction, 'utf8')
  })
}

export interface RelayDeliveryOptions {
  sessionName: string
  text: string
  home: string
  env: NodeJS.ProcessEnv
  platform: Platform
  model: string
  /**
   * The BASE of the courier's time budget — `SENDTEXT_TIMEOUT_S` in
   * milliseconds, unchanged in meaning and in name (#439): every caller of
   * this function still hands in the same configured value it always has.
   * What changed is what this function DOES with it — `relayTimeoutMsFor`
   * adds a per-character allowance on top before it ever reaches the child
   * process, so a caller must not scale this itself.
   */
  timeoutMs: number
  run: RelayRunner
}

/**
 * Hand one message to a named Claude session through a throwaway relay turn.
 * Every failure mode becomes a `delivered: false` outcome with a reason the
 * panel can show, and the outcome never echoes the message back.
 */
export async function deliverViaRelay(options: RelayDeliveryOptions): Promise<TextDeliveryOutcome> {
  const command = resolveClaudeBinaryPath(options.home, options.platform)
  // #439: the budget grows with the instruction, so a long message gets a
  // turn long enough to finish rather than being killed for producing more of
  // it.
  const timeoutMs = relayTimeoutMsFor(options.timeoutMs, options.text.length)
  try {
    const result = await options.run({
      command,
      args: buildRelayArgs({ model: options.model }),
      // The person's words leave this app on a stream, not a command line
      // (#437). Nothing of the instruction is in `args`, which is what lets a
      // message be as long as it likes.
      instruction: buildRelayInstruction(options.sessionName, options.text),
      env: buildRelayEnv(options.env, command, options.platform),
      cwd: options.home,
      timeoutMs
    })
    if (result.timedOut) {
      // #439: a courier killed by this app's own timeout may already have
      // called SendMessage — the delivery happens partway through the turn,
      // before the courier's own reply — so this is NOT a proven failure.
      // `unconfirmed` says so rather than leaving the panel to draw a ✕ and
      // offer a `Send again` that could put the words in twice; `neverStarted`
      // stays unset for the same reason it already does here (see the catch
      // below), so no other tier resends either.
      return {
        delivered: false,
        unconfirmed: true,
        error: 'The relay did not confirm in time; the message may have arrived.'
      }
    }
    if (result.exitCode !== 0) {
      return {
        delivered: false,
        error: `The relay could not deliver the message (exit ${result.exitCode}).`
      }
    }
    return { delivered: true }
  } catch {
    // The one failure that PROVES nothing was handed over: the binary never
    // ran, so no SendMessage call can have happened. Neither branch above is
    // marked `neverStarted` — a non-zero exit and a timeout kill can each land
    // after the tool call succeeded — and that is what decides whether the
    // console tier behind this may retry the same text (#308).
    return { delivered: false, error: 'The relay could not be started.', neverStarted: true }
  }
}
