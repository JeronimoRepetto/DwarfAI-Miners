import type { ProbeCommand } from '../adapters/processProbe'
import type { CommandRunner } from '../platform/unixFocus'
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

/** Typing into the foreground console, as far as one platform can do it. */
export interface ConsoleInputAdapter {
  sendText(text: string, pressEnter: boolean): Promise<boolean>
  sendInterrupt(): Promise<boolean>
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
