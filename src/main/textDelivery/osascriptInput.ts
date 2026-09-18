import type { ProbeCommand } from '../platform/processProbe'
import type { CommandRunner } from '../platform/unixFocus'
import type { DwarfAttachment } from '../domain/types'
import { toConsoleLine } from './sendKeys'

/**
 * Console input injection on macOS: ask System Events to synthesize keystrokes
 * into whatever window is in the foreground.
 *
 * This is the exact counterpart of the Windows SendKeys path (sendKeys.ts),
 * including its precondition: the target terminal must already have been
 * brought forward, because System Events types into the foreground window and
 * nothing else. Command construction is pure and unit-tested; running
 * osascript is integration territory, and it additionally requires the user to
 * grant Accessibility permission — which is why this adapter ships gated (see
 * platformAdapters.ts) until it has been verified on a real Mac.
 */

/** Key codes System Events uses for the two keys with no printable form. */
const RETURN_KEY_CODE = 36
const ESCAPE_KEY_CODE = 53

/**
 * Escape a string for an AppleScript double-quoted literal, where `\` and `"`
 * are the only two special characters. Backslashes go first: escaping the
 * quotes first would leave the backslash pass free to double the backslash it
 * just produced, re-opening the literal it was meant to close.
 */
export function escapeAppleScriptString(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function tellSystemEvents(clause: string): string {
  return `tell application "System Events" to ${clause}`
}

/**
 * osascript that types `text` into the foreground window, optionally followed
 * by Return as a separate key code — so a payload containing the literal text
 * "return" can never submit itself.
 */
export function buildOsascriptKeystrokeCommand(text: string, pressEnter: boolean): ProbeCommand {
  const keys = escapeAppleScriptString(toConsoleLine(text))
  const args = ['-e', tellSystemEvents(`keystroke "${keys}"`)]
  if (pressEnter) {
    args.push('-e', tellSystemEvents(`key code ${RETURN_KEY_CODE}`))
  }
  return { command: 'osascript', args }
}

/**
 * osascript that sends a bare Escape to the foreground window — Kick's
 * interrupt, the keystroke the Claude Code TUI cancels a turn on. Takes no
 * arguments: there is no user text involved at all.
 */
export function buildOsascriptInterruptCommand(): ProbeCommand {
  return { command: 'osascript', args: ['-e', tellSystemEvents(`key code ${ESCAPE_KEY_CODE}`)] }
}

/** What one message delivery into a console amounts to, for the port above it. */
export interface ConsoleMessageOutcome {
  delivered: boolean
  /** The sentence the panel shows; absent when it was delivered. */
  error?: string
  /**
   * Whether the console provably received NOTHING — the half that licenses the
   * relay to carry the same words. Read exactly as
   * `TextDeliveryOutcome.neverStarted` is, because that is what it becomes.
   */
  neverStarted?: boolean
}

/** One message for a console, the shape `ConsoleTextRequest` already carries. */
export interface ConsoleMessageRequest {
  pid: number
  text: string
  pressEnter: boolean
  attachments?: readonly DwarfAttachment[]
}

/** Typing into the foreground console, as far as one platform can do it. */
export interface ConsoleInputAdapter {
  sendText(text: string, pressEnter: boolean): Promise<boolean>
  sendInterrupt(): Promise<boolean>
  /**
   * Deliver a whole MESSAGE, attachments included, ADDRESSED rather than typed
   * (#367).
   *
   * Optional, and the absence is a per-OS answer rather than a gap, exactly as
   * `TextDeliveryPort`'s four optional methods are: the two methods above
   * synthesize keys at whatever holds the foreground, and a platform with no way
   * to address a console by name has no message tier at all. macOS has one — a
   * Terminal.app tab named by its tty, see `darwinConsoleInput.ts` — and Linux
   * has none, so `PosixTextDelivery` turns the absence into a stated refusal and
   * the relay carries the message.
   *
   * An outcome rather than a boolean, unlike the two above it: this is the tier
   * whose failures differ from each other in ways the person can act on (a
   * permission to grant, a terminal that is not Terminal.app), and the one whose
   * refusals decide whether the relay may send the same words again.
   */
  sendMessage?(request: ConsoleMessageRequest): Promise<ConsoleMessageOutcome>
}

/** The macOS console input adapter. Any osascript failure is reported as false. */
export function createOsascriptConsoleInput(run: CommandRunner): ConsoleInputAdapter {
  async function attempt(command: ProbeCommand): Promise<boolean> {
    try {
      await run(command)
      return true
    } catch {
      return false
    }
  }
  return {
    sendText: (text, pressEnter) => attempt(buildOsascriptKeystrokeCommand(text, pressEnter)),
    sendInterrupt: () => attempt(buildOsascriptInterruptCommand())
  }
}
