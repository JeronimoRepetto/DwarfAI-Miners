import { describe, expect, it } from 'vitest'
import { buildGracefulExitCommand, buildSendInterruptCommand, toConsoleLine } from './sendKeys'

/*
 * REMOVED by #371, with their subjects. `escapeSendKeys` (4 blocks, one of them
 * an it.each over the ten SendKeys control characters), `buildSendKeysCommand`
 * (7 blocks, including the four typographic quote codepoints an injection hole
 * once reached through) and `buildPasteCommand` (3 blocks) all went when text
 * left the keystroke path: a message and a permission digit are written into
 * the console the session's pid names, so nothing here carries user text any
 * more and there is nothing left to escape.
 *
 * The coverage that replaced them is `consoleInputWrite.test.ts`, which pins
 * the same class of attack against the mechanism that now carries the text —
 * its base64 payload leaves no quote, backtick or here-string terminator for a
 * tokenizer to reach. The removed builders are in the history if a keystroke
 * ever needs to carry text again.
 */

describe('toConsoleLine', () => {
  it('collapses newlines so a multi-line message cannot submit itself early', () => {
    expect(toConsoleLine('first line\nsecond line')).toBe('first line second line')
  })

  it('collapses CRLF, tabs and runs of whitespace into single spaces', () => {
    expect(toConsoleLine('a\r\n\r\nb\tc')).toBe('a b c')
  })

  it('trims the surrounding whitespace', () => {
    expect(toConsoleLine('  padded  ')).toBe('padded')
  })
})

describe('buildSendInterruptCommand', () => {
  it('sends the raw ESC keystroke Claude Code interrupts a turn on', () => {
    const command = buildSendInterruptCommand()
    expect(command).toContain('Add-Type -AssemblyName System.Windows.Forms')
    expect(command).toContain("SendWait('{ESC}')")
  })

  it('spells the keyname live, never as the three characters an escape would make of it', () => {
    // AMENDED for #371: this asserted the same thing through escapeSendKeys,
    // which went with the text builders. `{{}ESC{}}` is what that transform
    // produced — three literal characters where an Escape keypress belongs.
    expect(buildSendInterruptCommand()).not.toContain('{{}ESC{}}')
  })

  it('takes no arguments: the interrupt is a fixed keystroke, never user text', () => {
    expect(buildSendInterruptCommand).toHaveLength(0)
  })
})

/*
 * The graceful-exit path (#358): Kick's terminal tier asks the CLI to exit the
 * way its own /exit would before it force-kills anything, so the TUI runs its
 * teardown and restores the terminal (the mouse-tracking modes taskkill /F left
 * on). Measured live by the maintainer on 2026-09-10: the Claude Code TUI on
 * Windows exits CLEANLY on Ctrl+C twice — one Ctrl+C then Ctrl+D does not — so
 * this presses `^c` twice. Like {ESC} and ^v, `^c` IS the SendKeys keyname and
 * carries no user text, so it never touches escapeSendKeys.
 */
describe('buildGracefulExitCommand', () => {
  it('presses Ctrl+C twice — the two the Claude TUI needs to exit cleanly', () => {
    const command = buildGracefulExitCommand()
    expect(command).toContain('Add-Type -AssemblyName System.Windows.Forms')
    expect(command.match(/SendWait\('\^c'\)/g)).toHaveLength(2)
  })

  it('settles the just-focused terminal before the first Ctrl+C, and waits between the two', () => {
    // The same settle sleeps every builder here uses: 150ms so the freshly
    // foregrounded terminal is ready for the first keystroke, 120ms between the
    // two so the TUI registers them as two distinct Ctrl+C, not one.
    expect(buildGracefulExitCommand().split('\n')).toEqual([
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Windows.Forms',
      'Start-Sleep -Milliseconds 150',
      "[System.Windows.Forms.SendKeys]::SendWait('^c')",
      'Start-Sleep -Milliseconds 120',
      "[System.Windows.Forms.SendKeys]::SendWait('^c')"
    ])
  })

  it('spells the keyname live, never as the literal characters an escape would make of it', () => {
    // AMENDED for #371 with the interrupt's twin above: `{^}c` is what the
    // escaping path produced, literal characters where a Ctrl+C belongs.
    expect(buildGracefulExitCommand()).not.toContain('{^}c')
  })

  it('takes no arguments: the clean exit is a fixed keystroke pair, never user text', () => {
    expect(buildGracefulExitCommand).toHaveLength(0)
  })
})

/*
 * REMOVED by #402, with its subject. `buildQuestionAnswerCommand` (7 blocks,
 * one of them an it.each over the seven non-digits the guard refuses) went when
 * the AskUserQuestion picker's keys left the keystroke path: the digits, the
 * confirmation and the Enter are written into the console the session's pid
 * names now, one `WriteConsoleInputW` call each, so there is no SendKeys
 * command left for it to build and no `{RIGHT}` keyname to spell.
 *
 * The coverage that replaced it is in two places, and between them they hold
 * every block removed here. `questionAnswerChunks` in `questionKeys.test.ts`
 * inherited the digit guard — the empty set, the tenth option, and the seven
 * non-digits — plus the measured order the chunks go in. The script those
 * chunks become is `buildConsoleInputSequenceCommand` in
 * `consoleInputWrite.test.ts`, which pins one call per chunk, the delay between
 * them, and the absence of every API that could reach a window.
 */
