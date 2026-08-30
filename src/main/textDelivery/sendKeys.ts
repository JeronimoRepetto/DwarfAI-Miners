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
