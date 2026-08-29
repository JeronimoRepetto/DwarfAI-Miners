import { describe, expect, it } from 'vitest'
import { buildSendKeysCommand, escapeSendKeys, toConsoleLine } from './sendKeys'

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
