/**
 * Console input injection on Windows, v1: bring the hosting terminal forward
 * (see focus.ts) and synthesize the keystrokes with `SendKeys`.
 *
 * SendKeys is the pragmatic mechanism rather than the ideal one — it types into
 * whatever window is in the foreground, so it depends on the focus step having
 * succeeded. It lives behind TextDeliveryPort precisely so a stricter
 * AttachConsole/WriteConsoleInput implementation can replace it later without
 * anything above noticing. Command construction is pure and unit-tested; only
 * running PowerShell is integration territory.
 */

/**
 * The characters SendKeys reads as syntax rather than text: braces delimit key
 * names ({ENTER}), and +^%~()[] carry modifier/grouping meaning. Each is
 * escaped by wrapping it in braces, in a SINGLE pass — escaping them one
 * character at a time would re-escape the braces the earlier passes produced.
 */
const SENDKEYS_SYNTAX = /[{}+^%~()[\]]/g

export function escapeSendKeys(text: string): string {
  return text.replace(SENDKEYS_SYNTAX, (character) => `{${character}}`)
}

/**
 * Flatten a message to one line. A console has no way to accept a literal
 * newline without submitting the line, so a pasted paragraph would otherwise
 * send its first line and leave the rest typed into a fresh prompt.
 */
export function toConsoleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Every codepoint PowerShell's tokenizer will accept as a single-quote
 * delimiter. It normalises the three typographic variants to U+0027 while
 * parsing, so all four close a literal and all four must be doubled.
 *
 * Escaping only U+0027 was an arbitrary-execution hole: a curly apostrophe
 * closed the string and everything after it parsed as code. It needed no
 * hostile intent either — word processors and phone keyboards emit U+2019 by
 * default, so ordinary pasted prose reached it.
 */
const POWERSHELL_QUOTES = ["'", '‘', '’', '‚', '‛']

/** Escape for a PowerShell single-quoted literal by doubling every delimiter. */
function powerShellLiteral(text: string): string {
  return [...text].map((char) => (POWERSHELL_QUOTES.includes(char) ? char + char : char)).join('')
}

/**
 * PowerShell that types `text` into the foreground window, optionally followed
 * by ENTER as a separate keystroke (so a payload containing the literal text
 * "{ENTER}" can never submit itself — escapeSendKeys neutralizes it first).
 *
 * The short sleeps give the just-focused terminal time to settle before the
 * first character and before the submit, which on a busy machine is the
 * difference between a complete line and a truncated one.
 */
export function buildSendKeysCommand(text: string, pressEnter: boolean): string {
  const keys = powerShellLiteral(escapeSendKeys(toConsoleLine(text)))
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Start-Sleep -Milliseconds 150',
    `[System.Windows.Forms.SendKeys]::SendWait('${keys}')`
  ]
  if (pressEnter) {
    lines.push(
      'Start-Sleep -Milliseconds 120',
      "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')"
    )
  }
  return lines.join('\n')
}

/**
 * PowerShell that pastes the clipboard into the foreground window — Ctrl+V,
 * optionally followed by ENTER as a separate keystroke (#319).
 *
 * This is the message path since #319: the text is put on the clipboard and
 * pasted in one keystroke rather than typed character by character, so a long
 * message lands at once and the window in which a mid-typing focus change could
 * steal the rest of it nearly disappears (measured: 441 chars typed took ~16 s).
 *
 * Deliberately built without escapeSendKeys/buildSendKeysCommand, for the same
 * reason buildSendInterruptCommand is: `^v` and `{ENTER}` here ARE the SendKeys
 * keynames, and there is no user text to escape — the message never enters this
 * command, it rides the clipboard. `^v` is SendKeys for Ctrl+V (`^` is its Ctrl
 * modifier), the same spelling `{ENTER}` and `{ESC}` are the transport's own.
 *
 * The settle sleeps mirror buildSendKeysCommand's: the just-focused terminal
 * needs a moment before the paste, and the paste a moment before the submit.
 */
export function buildPasteCommand(pressEnter: boolean): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Start-Sleep -Milliseconds 150',
    "[System.Windows.Forms.SendKeys]::SendWait('^v')"
  ]
  if (pressEnter) {
    lines.push(
      'Start-Sleep -Milliseconds 120',
      "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')"
    )
  }
  return lines.join('\n')
}

/**
 * PowerShell that sends a raw ESC keystroke to the foreground window — this is
 * how the Claude Code TUI interrupts (Kick's cancel), not typed text.
 *
 * Deliberately built without escapeSendKeys/buildSendKeysCommand: `{ESC}` here
 * IS the SendKeys keyname, and running it through the escaping path meant for
 * arbitrary user text would turn it into the three literal characters
 * `{{}ESC{}}` instead of the actual Escape keypress. There is no user text
 * involved at all — this command takes no arguments.
 */
export function buildSendInterruptCommand(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Start-Sleep -Milliseconds 150',
    "[System.Windows.Forms.SendKeys]::SendWait('{ESC}')"
  ].join('\n')
}

/**
 * PowerShell that asks the foreground CLI to exit the way its own /exit would —
 * Ctrl+C, a short settle, then Ctrl+C again — so it runs its teardown and hands
 * the terminal back clean (#358).
 *
 * TWO Ctrl+C on purpose: measured live by the maintainer on 2026-09-10, the
 * Claude Code TUI on Windows exits CLEANLY on Ctrl+C twice (a single Ctrl+C
 * then Ctrl+D does not), and a clean exit is what resets the mouse-tracking
 * modes a taskkill /F leaves on — the endless SGR mouse reports #358 is about.
 * Kick's terminal tier presses this first and only force-kills if the process
 * survives.
 *
 * Deliberately built without escapeSendKeys, exactly as buildSendInterruptCommand
 * and buildPasteCommand are: `^c` IS the SendKeys keyname for Ctrl+C (`^` is its
 * Ctrl modifier), and running it through the escaping path meant for arbitrary
 * user text would turn it into the literal characters `{^}c` instead of the
 * keystroke. There is no user text here — the command takes no arguments.
 *
 * The settle sleeps mirror the other builders': 150ms so the just-focused
 * terminal is ready for the first Ctrl+C, 120ms between the two so the TUI
 * registers them as two distinct keystrokes rather than one.
 */
export function buildGracefulExitCommand(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Start-Sleep -Milliseconds 150',
    "[System.Windows.Forms.SendKeys]::SendWait('^c')",
    'Start-Sleep -Milliseconds 120',
    "[System.Windows.Forms.SendKeys]::SendWait('^c')"
  ].join('\n')
}
