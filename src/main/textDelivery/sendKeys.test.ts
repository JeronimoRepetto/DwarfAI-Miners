import { describe, expect, it } from 'vitest'
import {
  buildGracefulExitCommand,
  buildQuestionAnswerCommand,
  buildSendInterruptCommand,
  toConsoleLine
} from './sendKeys'

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
 * The question-answer path (#362). Claude Code's AskUserQuestion picker is a
 * selector like the permission dialog, and its two gestures were measured live
 * by the maintainer on 2026-09-10 (Claude Code 2.1.267, Windows Terminal), one
 * question per call:
 *
 * - single-select: the option's DIGIT selects and submits by itself. No Enter,
 *   no confirmation screen.
 * - multi-select: each digit TOGGLES its option and the cursor does not move;
 *   `{RIGHT}` shows the summary and `{ENTER}` accepts it.
 *
 * Like {ESC}, ^v and ^c, `{RIGHT}` and `{ENTER}` here ARE SendKeys keynames and
 * carry no user text, so they never touch escapeSendKeys.
 */
describe('buildQuestionAnswerCommand', () => {
  it('presses one digit and nothing else for a single-select answer', () => {
    // The measured single-select gesture: the digit fires the selection on its
    // own, so there is nothing to submit and no confirmation to accept.
    expect(buildQuestionAnswerCommand(['3'], false)!.split('\n')).toEqual([
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Windows.Forms',
      'Start-Sleep -Milliseconds 150',
      "[System.Windows.Forms.SendKeys]::SendWait('3')"
    ])
  })

  it('toggles each digit then submits with RIGHT and ENTER, in that order', () => {
    // The measured multi-select gesture. RIGHT shows the summary of what is
    // toggled and ENTER accepts it; the same settle sleeps every builder here
    // uses sit between the keys.
    expect(buildQuestionAnswerCommand(['2', '4'], true)!.split('\n')).toEqual([
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Windows.Forms',
      'Start-Sleep -Milliseconds 150',
      "[System.Windows.Forms.SendKeys]::SendWait('2')",
      'Start-Sleep -Milliseconds 120',
      "[System.Windows.Forms.SendKeys]::SendWait('4')",
      'Start-Sleep -Milliseconds 120',
      "[System.Windows.Forms.SendKeys]::SendWait('{RIGHT}')",
      'Start-Sleep -Milliseconds 120',
      "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')"
    ])
  })

  it('spells both keynames live, never as the characters an escape would make of them', () => {
    // AMENDED for #371 with the two above: an escaped keyname is literal
    // characters where a keystroke belongs.
    const command = buildQuestionAnswerCommand(['1'], true)!
    expect(command).not.toContain('{{}RIGHT{}}')
    expect(command).not.toContain('{{}ENTER{}}')
    expect(command).toContain("SendWait('{RIGHT}')")
  })

  it('presses PageDown nowhere: it opens the free-text row, not the summary', () => {
    // Measured 2026-09-10: End does nothing and PageDown jumps to the "Other"
    // row and waits for free text. Neither is a route to submit, and an ENTER
    // landing there would open a composer nobody asked for.
    const command = buildQuestionAnswerCommand(['1', '2'], true)!
    expect(command).not.toContain('PGDN')
    expect(command).not.toContain('END')
  })

  it('refuses to build anything for an empty set of digits', () => {
    // Nothing was chosen, so there is no answer to press. Null rather than a
    // command that only submits: {RIGHT}{ENTER} on an untouched picker would
    // accept an empty answer.
    expect(buildQuestionAnswerCommand([], true)).toBeNull()
    expect(buildQuestionAnswerCommand([], false)).toBeNull()
  })

  it('refuses a tenth option, which has no digit to press', () => {
    const nine = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
    expect(buildQuestionAnswerCommand(nine, true)).not.toBeNull()
    expect(buildQuestionAnswerCommand([...nine, '1'], true)).toBeNull()
  })

  it.each([['0'], ['10'], [''], ['a'], ['{ENTER}'], ['1 2'], ['+']])(
    'refuses %s, which is not one of the nine digits this picker answers to',
    (digit) => {
      // The whole payload this command can carry is a digit, so the guard is
      // what keeps arbitrary text out of a keystroke that never escapes it.
      expect(buildQuestionAnswerCommand([digit], false)).toBeNull()
    }
  )
})
