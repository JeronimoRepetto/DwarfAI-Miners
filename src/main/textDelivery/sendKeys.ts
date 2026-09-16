import { normalizeConsoleText } from '../../shared/consoleText'

/**
 * KEYSTROKES on Windows: bring the hosting terminal forward (see focus.ts) and
 * synthesize them with `SendKeys`.
 *
 * SendKeys types into whatever window is in the foreground, so it depends on
 * the focus step having succeeded — which is why #371 took TEXT off it
 * entirely. A message and a permission digit are written into the console the
 * session's pid names now (consoleInputWrite.ts), the replacement this header
 * used to anticipate, and #402 sent the question picker's keys the same way
 * once the confirmation it was waiting on turned out to be three ordinary
 * characters rather than a virtual key. What is left here is the interrupt's
 * Escape and the clean exit's Ctrl+C — both of which the #402 pass measured as
 * deliverable text records too, and neither of which moved in it, because a
 * key that ends a turn or a session deserves its own change.
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
 *
 * The rule itself lives in `shared/consoleText.ts` now (#419): the renderer's
 * echo reconciliation has to flatten a message the same way before comparing
 * it against a transcript row, and the renderer cannot import from `main`, so
 * the one regex both sides need moved to the one place both can reach it.
 * This function stays as the name every caller here already uses.
 */
export function toConsoleLine(text: string): string {
  return normalizeConsoleText(text)
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

/*
 * `buildQuestionAnswerCommand` stood here until #402, and it went with the last
 * thing that needed a keyname carrying no character. Its `{RIGHT}` was the
 * whole reason the picker stayed on this path — and the arrow turned out not to
 * be a virtual key at all: ConPTY hands the hosted process VT input, so the
 * three ordinary characters `ESC [ C` move the picker, and an answer is written
 * into the session's own console by pid like everything else. See
 * `questionAnswerChunks` in questionKeys.ts for the keys and
 * `buildConsoleInputSequenceCommand` in consoleInputWrite.ts for the write.
 */
