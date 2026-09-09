import { describe, expect, it } from 'vitest'
import {
  buildPasteCommand,
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
