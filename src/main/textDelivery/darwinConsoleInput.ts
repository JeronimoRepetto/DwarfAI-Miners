import {
  AUTOMATION_PERMISSION_DENIED,
  TERMINAL_HOST_UNMEASURED,
  createDarwinConsoleReach,
  isAutomationPermissionDenied
} from '../platform/darwinTabReach'
import type { CommandRunner } from '../platform/unixFocus'
import { createOsascriptConsoleInput, type ConsoleInputAdapter } from './osascriptInput'
import type { ConsoleMessageOutcome, ConsoleMessageRequest } from './osascriptInput'
import { buildTerminalTabWriteCommand, terminalTabPayloadFor } from './terminalTabWrite'

/**
 * The macOS console input adapter, which since #367 is TWO mechanisms behind
 * one port — and the split is the point rather than a compromise.
 *
 * - A **message** is written into the Terminal.app tab the session's tty names
 *   (`terminalTabWrite.ts`), as a paste followed by its own submit call. No
 *   window is raised, the foreground never moves, and the tab strip is never
 *   consulted, which is the same thing the Windows write by pid bought at #371.
 *   It needs only Automation permission.
 * - A **key that must not submit** — #203's permission digit, and the Escape
 *   behind a deny — stays on System Events keystrokes
 *   (`createOsascriptConsoleInput`). It cannot move, because every `do script`
 *   call appends exactly one carriage return and there is no form of it that
 *   appends none. A digit fires its row by itself and the Return behind it
 *   would then submit whatever the composer holds next. Forcing one mechanism
 *   to carry both acts is the conflation #366 had to undo for the kick; this
 *   states the two acts as two rather than repeating it.
 *
 * So the keystroke path keeps its own preconditions — the foreground, and
 * Accessibility permission — and the message path is free of both. That
 * asymmetry is real and is stated here rather than smoothed over: the panel can
 * write a message into a background tab and still be unable to answer a
 * permission prompt in it.
 *
 * **What this header claimed until 2026-09-18, and why it was wrong.** It said
 * the message tier was the inverse of the Windows write — one call, whose own
 * appended Return submitted the lot. That held against the raw-mode node reader
 * it was measured on and failed against a live Claude Code TUI, which pasted
 * every message and submitted none, concatenating two of them in the composer.
 * It is #404 on a second platform: Ink reads a chunk arriving in one read as a
 * paste, and a carriage return inside a paste is line content. The submit is a
 * second `do script ""` now, so the two platforms follow the SAME rule. The
 * split above is untouched by that — a digit still travels as one call with its
 * Return, measured 2026-09-18 to be what the permission dialog and a
 * single-select picker take.
 */

/** The message could not be turned into one payload — an over-long path (#425). */
export const MESSAGE_UNBUILDABLE = 'That message could not be prepared for the terminal.'

/**
 * A message that must arrive WITHOUT submitting, which this tier cannot do.
 *
 * Stated rather than silently submitted. The tier is a paste plus a submit
 * call, and dropping the submit would not help: the payload's own appended
 * Return would still be sitting in the composer as a line break nobody asked
 * for. So the honest answer is that nothing was written — `neverStarted`, which
 * lets the relay carry the words instead.
 */
export const RETURN_CANNOT_BE_WITHHELD =
  'Terminal.app always submits what the panel writes, so this message was not written.'

/** An unexplained osascript failure: it may have written, so nothing may claim otherwise. */
const WRITE_FAILED = 'The message could not be written into that terminal tab.'

/** The error the write script raises when no tab is on that tty any more. */
const NO_TAB_ERROR = 'no Terminal tab on that tty'

/**
 * The macOS console input adapter. Keystroke failures stay booleans, exactly as
 * before; the message tier answers with a reason, because it is the one the
 * panel shows a sentence for and the one whose failures differ from each other.
 */
export function createDarwinConsoleInput(
  run: CommandRunner
): ConsoleInputAdapter & { sendMessage: NonNullable<ConsoleInputAdapter['sendMessage']> } {
  const keystrokes = createOsascriptConsoleInput(run)
  const reachOf = createDarwinConsoleReach(run)

  async function sendMessage(request: ConsoleMessageRequest): Promise<ConsoleMessageOutcome> {
    if (!request.pressEnter) {
      return { delivered: false, error: RETURN_CANNOT_BE_WITHHELD, neverStarted: true }
    }
    const payload = terminalTabPayloadFor(request.text, request.attachments ?? [])
    if (payload === null) {
      return { delivered: false, error: MESSAGE_UNBUILDABLE, neverStarted: true }
    }
    const reach = await reachOf(request.pid)
    if (reach.reach === 'terminal-host') {
      return { delivered: false, error: reach.error, neverStarted: true }
    }
    const command = buildTerminalTabWriteCommand(reach.tty, payload)
    // Unreachable through the reach verdict above, which only ever answers a
    // device path — kept because the builder's refusal is fail-closed and a
    // caller that swallowed it would write nothing and report success.
    if (command === null) {
      return { delivered: false, error: MESSAGE_UNBUILDABLE, neverStarted: true }
    }
    try {
      await run(command)
      return { delivered: true }
    } catch (error) {
      // Two failures provably wrote nothing: TCC refusing the Apple event, and
      // the script's own error for a tab that closed between the reach and the
      // write. Anything else takes the cautious reading the Windows port takes —
      // it may have landed, so no second tier is licensed to send it again.
      if (isAutomationPermissionDenied(error)) {
        return { delivered: false, error: AUTOMATION_PERMISSION_DENIED, neverStarted: true }
      }
      if (error instanceof Error && error.message.includes(NO_TAB_ERROR)) {
        return { delivered: false, error: TERMINAL_HOST_UNMEASURED, neverStarted: true }
      }
      return { delivered: false, error: WRITE_FAILED }
    }
  }

  return { ...keystrokes, sendMessage }
}
