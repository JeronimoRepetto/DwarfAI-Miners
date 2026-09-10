import { describe, expect, it } from 'vitest'
import {
  buildGracefulExitCommand,
  buildPasteCommand,
  buildQuestionAnswerCommand,
  buildSendInterruptCommand,
  buildSendKeysCommand,
  escapeSendKeys,
  toConsoleLine
} from './sendKeys'

describe('escapeSendKeys', () => {
  it('leaves ordinary text untouched', () => {
    expect(escapeSendKeys('run the tests please')).toBe('run the tests please')
  })

  it.each([
    ['{', '{{}'],
    ['}', '{}}'],
    ['+', '{+}'],
    ['^', '{^}'],
    ['%', '{%}'],
    ['~', '{~}'],
    ['(', '{(}'],
    [')', '{)}'],
    ['[', '{[}'],
    [']', '{]}']
  ])('escapes the SendKeys control character %s', (input, expected) => {
    expect(escapeSendKeys(input)).toBe(expected)
  })

  it('escapes every control character in one pass, never re-escaping its own braces', () => {
    expect(escapeSendKeys('a+b')).toBe('a{+}b')
    expect(escapeSendKeys('fn(x)')).toBe('fn{(}x{)}')
    // The braces this produces must not themselves be escaped again.
    expect(escapeSendKeys('50%')).toBe('50{%}')
  })

  it('escapes a payload that tries to smuggle a literal ENTER keystroke', () => {
    expect(escapeSendKeys('{ENTER}')).toBe('{{}ENTER{}}')
  })
})

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

describe('buildSendKeysCommand', () => {
  it('types the escaped text into the foreground window', () => {
    const command = buildSendKeysCommand('hello', false)
    expect(command).toContain('Add-Type -AssemblyName System.Windows.Forms')
    expect(command).toContain("SendWait('hello')")
  })

  it('doubles single quotes so the payload cannot break out of the PowerShell literal', () => {
    expect(buildSendKeysCommand("don't", false)).toContain("SendWait('don''t')")
  })

  /*
    PowerShell's tokenizer accepts four codepoints as a single-quote delimiter,
    not one: it normalises the three typographic variants to U+0027 while
    parsing. Doubling only the straight apostrophe therefore left the other
    three able to close the literal, and everything after them parsed as code.
    Verified against a real powershell.exe before this test was written:
    `hi<U+2019>);Write-Output 'X';(<U+2019>` executed the injected command.

    A curly apostrophe is not exotic — every word processor and phone keyboard
    emits one, so this fired on ordinary pasted prose as readily as on a
    hostile payload.
  */
  it.each([
    ['U+2018 left single quote', '‘'],
    ['U+2019 right single quote', '’'],
    ['U+201A single low-9 quote', '‚'],
    ['U+201B single high-reversed-9 quote', '‛']
  ])('doubles %s, which PowerShell also treats as a delimiter', (_label, quote) => {
    const command = buildSendKeysCommand(`hi${quote});Write-Output 'x';(${quote}`, false)
    expect(command).toContain(`${quote}${quote}`)
    // Every quote inside the literal is doubled, so the argument still closes
    // exactly where we put it: one SendWait call, not two statements.
    expect(command.match(/SendWait\(/g)).toHaveLength(1)
  })

  it('escapes SendKeys control characters before embedding them', () => {
    expect(buildSendKeysCommand('a+b', false)).toContain("SendWait('a{+}b')")
  })

  it('appends a separate ENTER keystroke only when asked', () => {
    expect(buildSendKeysCommand('hello', true)).toContain("SendWait('{ENTER}')")
    expect(buildSendKeysCommand('hello', false)).not.toContain("SendWait('{ENTER}')")
  })

  it('collapses newlines so a pasted paragraph never submits itself mid-way', () => {
    expect(buildSendKeysCommand('one\ntwo', true)).toContain("SendWait('one two')")
  })

  it('neutralizes a combined hostile payload, leaving only the trailing ENTER live', () => {
    const command = buildSendKeysCommand('it\'s {ENTER} +^%~()[] "quoted" 50%', true)
    expect(command).toContain(
      "SendWait('it''s {{}ENTER{}} {+}{^}{%}{~}{(}{)}{[}{]} \"quoted\" 50{%}')"
    )
    // Exactly one live ENTER keystroke: our own trailing one.
    expect(command.match(/SendWait\('\{ENTER\}'\)/g)).toHaveLength(1)
  })
})

/*
 * The paste path (#319): a MESSAGE is put on the clipboard and pasted with
 * Ctrl+V instead of typed character by character, so a 441-char message lands
 * at once rather than over ~16 s of foregrounded typing. The command carries no
 * user text at all — the text travels on the clipboard, and this only presses
 * the two keys — so unlike buildSendKeysCommand it never touches escapeSendKeys.
 */
describe('buildPasteCommand', () => {
  it('sends the Ctrl+V keystroke that pastes the clipboard into the foreground window', () => {
    const command = buildPasteCommand(false)
    expect(command).toContain('Add-Type -AssemblyName System.Windows.Forms')
    expect(command).toContain("SendWait('^v')")
  })

  it('appends a separate ENTER keystroke only when asked', () => {
    expect(buildPasteCommand(true)).toContain("SendWait('{ENTER}')")
    expect(buildPasteCommand(false)).not.toContain("SendWait('{ENTER}')")
  })

  it('carries no user text: the message travels on the clipboard, only the keys are pressed', () => {
    // One argument — pressEnter — and nothing that could smuggle a payload
    // through: the whole point of pasting is that the text is never in the
    // command a shell re-parses.
    expect(buildPasteCommand).toHaveLength(1)
  })
})

describe('buildSendInterruptCommand', () => {
  it('sends the raw ESC keystroke Claude Code interrupts a turn on', () => {
    const command = buildSendInterruptCommand()
    expect(command).toContain('Add-Type -AssemblyName System.Windows.Forms')
    expect(command).toContain("SendWait('{ESC}')")
  })

  it('never routes {ESC} through the message-escaping path, which would neutralize it', () => {
    // escapeSendKeys would turn the keyname into three literal characters
    // ({{}ESC{}}) instead of the actual Escape keystroke — see escapeSendKeys's
    // own 'smuggle a literal ENTER' test for what that transform does.
    expect(buildSendInterruptCommand()).not.toContain(escapeSendKeys('{ESC}'))
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

  it('never routes ^c through the message-escaping path, which would neutralize it', () => {
    // escapeSendKeys would turn the keyname into the literal characters `{^}c`
    // instead of the actual Ctrl+C keystroke — exactly as it would to {ESC}.
    expect(buildGracefulExitCommand()).not.toContain(escapeSendKeys('^c'))
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

  it('never routes {RIGHT} or {ENTER} through the message-escaping path', () => {
    // escapeSendKeys would turn either keyname into its literal characters
    // instead of the keystroke — see its own 'smuggle a literal ENTER' test.
    const command = buildQuestionAnswerCommand(['1'], true)!
    expect(command).not.toContain(escapeSendKeys('{RIGHT}'))
    expect(command).not.toContain(escapeSendKeys('{ENTER}'))
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
