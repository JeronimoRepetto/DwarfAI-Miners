import {
  AUTOMATION_PERMISSION_DENIED,
  TERMINAL_HOST_UNMEASURED,
  TTY_UNKNOWN,
  createDarwinConsoleReach,
  isAutomationPermissionDenied
} from '../platform/darwinTabReach'
import type { ProbeCommand } from '../platform/processProbe'
import type { CommandRunner } from '../platform/unixFocus'
import { createOsascriptConsoleInput, type ConsoleInputAdapter } from './osascriptInput'
import type { ConsoleMessageOutcome, ConsoleMessageRequest } from './osascriptInput'
import { buildTerminalTabWriteCommand, terminalTabPayloadFor } from './terminalTabWrite'
import { createTmuxConsoleInput } from './tmuxConsoleInput'

/**
 * The macOS console input adapter, which since #367 is TWO mechanisms behind
 * one port — and the split is the point rather than a compromise.
 *
 * - A **message** is written into the Terminal.app tab the session's tty names
 *   (`terminalTabWrite.ts`), as a paste followed by its own submit call. No
 *   window is raised, the foreground never moves, and the tab strip is never
 *   consulted, which is the same thing the Windows write by pid bought at #371.
 *   It needs only Automation permission.
 * - A **single-digit key** — #203's permission decision, and a single-select
 *   picker's answer — is written into that same tab as ONE `do script` call
 *   (#471). Measured 2026-09-18: `4` (No) closed the permission dialog cleanly
 *   and the appended Return was consumed as the confirmation, and a picker's
 *   `2` selected and confirmed in the same one call. One call, not the two a
 *   message takes, because a lone digit is read as a keystroke rather than as a
 *   paste — #404's rule does not reach it.
 * - **Every other key** stays on System Events keystrokes
 *   (`createOsascriptConsoleInput`), and the adapter says so by answering
 *   `null` rather than by failing.
 *
 * **Why the line falls exactly at one digit, and not one step further.**
 * Measured the same day, a MULTI-SELECT picker was only partly addressable
 * through `do script`: the digit toggled late, digit-plus-Return did not
 * submit, and submitting turned out to need a Tab and then a digit — a sequence
 * nobody has measured through this route. So several digits, the Tab, the
 * cursor-right of #402 and the Escape of a deny are all refused BY SHAPE and
 * handed back. Guessing at the rest would answer a multi-select with a toggle
 * nobody confirmed, which is worse than the keystroke path's honest
 * preconditions.
 *
 * So the keystroke path keeps its own — the foreground, and Accessibility
 * permission — and everything on the addressed route is free of both. The
 * asymmetry is real and narrower than it was: the panel can now answer a
 * permission prompt in a background tab, and still cannot answer a multi-select
 * there.
 *
 * **What this header claimed until 2026-09-18, and why it was wrong.** It said
 * the message tier was the inverse of the Windows write — one call, whose own
 * appended Return submitted the lot. That held against the raw-mode node reader
 * it was measured on and failed against a live Claude Code TUI, which pasted
 * every message and submitted none, concatenating two of them in the composer.
 * It is #404 on a second platform: Ink reads a chunk arriving in one read as a
 * paste, and a carriage return inside a paste is line content. The submit is a
 * second `do script ""` now, so the two platforms follow the SAME rule. The
 * split above survived that correction and is the reason it is drawn where it
 * is: a digit travels as one call with its Return because a lone character is
 * not a paste, which is the same finding read from the other side.
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

/** An unexplained osascript failure on the key route: the row may have been pressed. */
const KEY_WRITE_FAILED = 'The key could not be written into that terminal tab.'

/**
 * The one key shape the tab write is measured to carry: exactly one digit that
 * numbers a row (#471).
 *
 * `1`–`9` and not `0`, because `0` numbers no row in either prompt — the
 * permission dialog and the picker both count from 1, the same bound
 * `questionKeys.ts` holds for its own digits. A `0` arriving here is a caller
 * that computed a position wrongly, and it belongs on the keystroke path, where
 * it was already harmless, rather than pressed into somebody's dialog.
 */
const ADDRESSABLE_KEY = /^[1-9]$/

/**
 * One refusal naming both tiers, for a session neither could reach.
 *
 * Both sentences rather than the tab's alone, because after #471 a refusal from
 * here is two facts and the person can act on either: no Terminal.app tab
 * carries that tty, AND no tmux pane does. Reporting only the first would leave
 * somebody who runs tmux reading advice about a terminal they are not using;
 * reporting only the second would lose the Automation permission, which is the
 * one refusal on this path that names its own fix.
 */
export function consoleRefusalNamingBoth(tabError: string, tmuxError: string): string {
  return `${tabError} ${tmuxError}`
}

/**
 * The macOS console input adapter. Keystroke failures stay booleans, exactly as
 * before; the message tier answers with a reason, because it is the one the
 * panel shows a sentence for and the one whose failures differ from each other.
 */
export function createDarwinConsoleInput(run: CommandRunner): ConsoleInputAdapter & {
  sendMessage: NonNullable<ConsoleInputAdapter['sendMessage']>
  sendKey: NonNullable<ConsoleInputAdapter['sendKey']>
} {
  const keystrokes = createOsascriptConsoleInput(run)
  const reachOf = createDarwinConsoleReach(run)
  /*
   * The second tier, tried when the first cannot name a tab (#471).
   *
   * A Mac session in iTerm2, WezTerm, kitty or any other host has no
   * Terminal.app tab carrying its tty — that is the whole of
   * TERMINAL_HOST_UNMEASURED — and under tmux it is nonetheless a PANE, which
   * is addressable exactly as a tab is. So the honest refusal this adapter has
   * made since #367 becomes a refusal only when both tiers have been asked.
   *
   * The tab goes FIRST and the order is not an accident: it is the tier that
   * was measured (2026-09-18, Terminal.app 470.2), and a session with both
   * must take the measured one. tmux, on this path as on Linux, is built and
   * unmeasured.
   */
  const tmux = createTmuxConsoleInput(run)

  async function sendMessage(request: ConsoleMessageRequest): Promise<ConsoleMessageOutcome> {
    const payload = terminalTabPayloadFor(request.text, request.attachments ?? [])
    if (payload === null) {
      return { delivered: false, error: MESSAGE_UNBUILDABLE, neverStarted: true }
    }
    const reach = await reachOf(request.pid)
    if (reach.reach === 'terminal-host') {
      return offerToTmux(reach.error, () => tmux.sendMessage(request))
    }
    /*
     * The tab's own constraint, and since #471 it is asked AFTER the reach
     * rather than before it. `do script` appends a Return no caller can remove,
     * so this tier cannot carry a message that must not submit — but tmux can,
     * because its submit is a separate call, and refusing up front would have
     * denied a tmux-hosted session an act that was available to it.
     */
    if (!request.pressEnter) {
      return { delivered: false, error: RETURN_CANNOT_BE_WITHHELD, neverStarted: true }
    }
    const command = buildTerminalTabWriteCommand(reach.tty, payload, true)
    // Unreachable through the reach verdict above, which only ever answers a
    // device path — kept because the builder's refusal is fail-closed and a
    // caller that swallowed it would write nothing and report success.
    if (command === null) {
      return { delivered: false, error: MESSAGE_UNBUILDABLE, neverStarted: true }
    }
    return runWrite(command, WRITE_FAILED)
  }

  /**
   * One key into the tab, or `null` for a key this route cannot carry.
   *
   * The shape guard comes FIRST, before the reach is even asked: a key that is
   * not ours must cost no Apple event, no permission prompt, and no `ps`. It
   * also has to leave the keystroke path exactly as it found it, which is what
   * `null` does — see `ConsoleInputAdapter.sendKey` for why that is a third
   * answer rather than a failure.
   *
   * `pressEnter` is deliberately ignored. Every caller of the key route passes
   * `false` (a digit fires its row by itself, and #203's path says so), and
   * `do script` appends a Return either way. What makes that harmless here, and
   * is the measurement this whole route rests on, is that the dialog CONSUMES
   * it as the confirmation rather than leaving it to fall into the next prompt.
   * That is true of a one-digit answer and of nothing else yet measured.
   */
  async function sendKey(request: ConsoleMessageRequest): Promise<ConsoleMessageOutcome | null> {
    if (!ADDRESSABLE_KEY.test(request.text)) return null
    const reach = await reachOf(request.pid)
    if (reach.reach === 'terminal-host') {
      // The digit already passed the shape guard above, and tmux's guard is the
      // same nine characters, so the offer below can only answer an outcome.
      return offerToTmux(reach.error, async () => (await tmux.sendKey(request)) ?? null)
    }
    // `submits` false: the digit is read as a keystroke rather than a paste, so
    // the Return `do script` already appends is the confirmation. A second call
    // would press Return again, into whatever the dialog opened onto (#471).
    const command = buildTerminalTabWriteCommand(reach.tty, request.text, false)
    if (command === null) return null
    return runWrite(command, KEY_WRITE_FAILED)
  }

  /**
   * Offer an act the Terminal.app tab could not take to the tmux tier.
   *
   * Only a REACH verdict comes here, never a failed write: a write that may
   * have landed must not be handed to a second tier, which is the same
   * cautious rule the Windows port holds and the reason `runWrite`'s own
   * refusals stay where they are.
   *
   * TTY_UNKNOWN is the one verdict that skips the offer. A pane is matched by
   * tty, so a session without one can match none, and asking would spend two
   * commands to learn what `ps` already said.
   *
   * A tmux refusal that proves nothing was written becomes one sentence naming
   * both tiers. Anything else — delivered, or a failure that may have written —
   * is tmux's own answer, carried through untouched.
   */
  async function offerToTmux(
    tabError: string,
    offer: () => Promise<ConsoleMessageOutcome | null>
  ): Promise<ConsoleMessageOutcome> {
    if (tabError === TTY_UNKNOWN) {
      return { delivered: false, error: tabError, neverStarted: true }
    }
    const outcome = await offer()
    if (outcome === null || outcome.neverStarted !== true) {
      return outcome ?? { delivered: false, error: tabError, neverStarted: true }
    }
    return {
      delivered: false,
      error: consoleRefusalNamingBoth(tabError, outcome.error ?? ''),
      neverStarted: true
    }
  }

  /**
   * Run one built write and turn what osascript did into an outcome.
   *
   * Shared by both routes because everything below the builder is the same act
   * and the same three readings. Only the sentence for the unexplained case
   * differs, because a half-written message and a key that may have pressed a
   * row are not the same thing to the person whose session it is.
   */
  async function runWrite(
    command: ProbeCommand,
    unexplained: string
  ): Promise<ConsoleMessageOutcome> {
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
      return { delivered: false, error: unexplained }
    }
  }

  return { ...keystrokes, sendMessage, sendKey }
}
