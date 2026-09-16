/**
 * KEYSTROKES on Windows: bring the hosting terminal forward (see focus.ts) and
 * synthesize them with `SendKeys`.
 *
 * SendKeys types into whatever window is in the foreground, so it depends on
 * the focus step having succeeded — which is why #371 took TEXT off it
 * entirely. A message and a permission digit are written into the console the
 * session's pid names now (consoleInputWrite.ts), the replacement this header
 * used to anticipate. What is left here is what a pid write cannot express: the
 * keys that carry no character at all — Escape, Ctrl+C, the picker's right
 * arrow — each a VIRTUAL KEY, and none of them measured as an input record.
 *
 * With the text builders went the SendKeys escaping (`escapeSendKeys`,
 * `powerShellLiteral` and the four quote codepoints it had to double). Every
 * command below carries a measured keyname or a guarded digit and no
 * user-authored text at all, so there is nothing left to escape; the history
 * holds them if a text keystroke is ever needed again. Command construction is
 * pure and unit-tested; only running PowerShell is integration territory.
 */

/**
 * Flatten a message to one line. A console has no way to accept a literal
 * newline without submitting the line, so a pasted paragraph would otherwise
 * send its first line and leave the rest typed into a fresh prompt.
 */
export function toConsoleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * PowerShell that sends a raw ESC keystroke to the foreground window — this is
 * how the Claude Code TUI interrupts (Kick's cancel), not typed text.
 *
 * `{ESC}` IS the SendKeys keyname: it is spelled here rather than derived from
 * anything a person wrote, and the escaping path that once existed for user
 * text would have turned it into the three literal characters `{{}ESC{}}`
 * instead of the actual Escape keypress. There is no user text involved at all
 * — this command takes no arguments.
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
 * `^c` IS the SendKeys keyname for Ctrl+C (`^` is its Ctrl modifier), exactly
 * as `{ESC}` above is its own: spelled here, never derived from anything a
 * person wrote, and never escaped — the escaping path meant for user text would
 * have turned it into the literal characters `{^}c` instead of the keystroke.
 * There is no user text here; the command takes no arguments.
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

/** The nine rows Claude Code's question picker numbers, and the only keys this builder presses. */
const ANSWER_DIGITS = /^[1-9]$/

/**
 * PowerShell that answers Claude Code's `AskUserQuestion` picker: each chosen
 * option's digit, then — for a multi-select — `{RIGHT}` and `{ENTER}` (#362).
 *
 * Measured live by the maintainer on 2026-09-10, Claude Code 2.1.267, Windows
 * Terminal, with ONE question per call:
 *
 * - **Single-select**: pressing the option's digit selects AND submits, with no
 *   Enter and no confirmation screen — the same shape #203's permission digit
 *   has. So a single-select answer is one digit and `submit` is false; an Enter
 *   behind it would submit the input box of a session whose picker has closed.
 * - **Multi-select**: each digit TOGGLES its option and the cursor does not
 *   move, so the digits need no arrow counting. `End` does nothing and
 *   `PageDown` jumps to the free-text "Other" row — never a route to submit,
 *   which is why neither appears here. `{RIGHT}` shows the summary of what is
 *   toggled and `{ENTER}` accepts it.
 *
 * Null rather than a throw, and for three reasons the one caller states to the
 * person: nothing was chosen (a bare `{RIGHT}{ENTER}` would accept an empty
 * answer), more rows than the picker numbers, or a "digit" that is not one of
 * the nine. That last guard is the whole of this command's safety, and it is
 * what a builder carrying no escaping needs: a digit is the entire payload.
 *
 * `{RIGHT}` and `{ENTER}` ARE the SendKeys keynames, exactly as `{ESC}` and
 * `^c` are their builders' — spelled here rather than derived from user text.
 * The RIGHT arrow is also why this path did not move to the pid write with
 * #371's text: an arrow carries no character, so the input record it would need
 * is one nothing has measured against a TUI.
 *
 * The settle sleeps mirror every other builder's: 150ms so the just-focused
 * terminal is ready for the first key, 120ms between keys so the TUI registers
 * each as its own keystroke rather than folding two together.
 *
 * This builder presses what it is told, and nothing here knows which window is
 * in front. Where these keys may be pressed at all is the port's question, and
 * since #371 its focus check can tell a phantom console owned by a tab strip
 * from a console a session is alone on — so a shared Windows Terminal window is
 * refused rather than answered in whichever tab was active.
 */
export function buildQuestionAnswerCommand(
  digits: readonly string[],
  submit: boolean
): string | null {
  if (digits.length === 0 || digits.length > 9) return null
  if (digits.some((digit) => !ANSWER_DIGITS.test(digit))) return null
  const keys = submit ? [...digits, '{RIGHT}', '{ENTER}'] : [...digits]
  const lines = ["$ErrorActionPreference = 'Stop'", 'Add-Type -AssemblyName System.Windows.Forms']
  for (const [index, key] of keys.entries()) {
    lines.push(
      `Start-Sleep -Milliseconds ${index === 0 ? 150 : 120}`,
      `[System.Windows.Forms.SendKeys]::SendWait('${key}')`
    )
  }
  return lines.join('\n')
}
