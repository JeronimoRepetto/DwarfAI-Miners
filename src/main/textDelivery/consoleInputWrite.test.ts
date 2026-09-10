import { describe, expect, it } from 'vitest'
import { buildConsoleInputWriteCommand } from './consoleInputWrite'

/** Read back the one base64 payload the script carries, as the text it decodes to. */
function payloadOf(script: string): string {
  const blob = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(script)?.[1]
  if (blob === undefined) throw new Error('no base64 payload in the script')
  return Buffer.from(blob, 'base64').toString('utf16le')
}

describe('buildConsoleInputWriteCommand', () => {
  it('refuses a pid that cannot name a process', () => {
    expect(buildConsoleInputWriteCommand(0, 'hello', true)).toBeNull()
    expect(buildConsoleInputWriteCommand(-1, 'hello', true)).toBeNull()
    expect(buildConsoleInputWriteCommand(1.5, 'hello', true)).toBeNull()
    expect(buildConsoleInputWriteCommand(Number.NaN, 'hello', true)).toBeNull()
  })

  it('refuses a call that would write nothing at all', () => {
    expect(buildConsoleInputWriteCommand(4242, '', false)).toBeNull()
    expect(buildConsoleInputWriteCommand(4242, '   \n  ', false)).toBeNull()
  })

  it('allows a bare Enter, which is a submit with no text', () => {
    const script = buildConsoleInputWriteCommand(4242, '', true)
    expect(script).not.toBeNull()
    expect(payloadOf(script as string)).toBe('')
    expect(script).toContain('$units.Add([char]13)')
  })

  it('attaches to the pid it was given', () => {
    const script = buildConsoleInputWriteCommand(4242, 'hello', false) as string
    expect(script).toContain('AttachConsole(4242)')
  })

  it('frees the caller console BEFORE attaching, which the attach requires', () => {
    const script = buildConsoleInputWriteCommand(4242, 'hello', false) as string
    expect(script.indexOf('FreeConsole()')).toBeLessThan(script.indexOf('AttachConsole('))
  })

  it('takes the input handle from CONIN$ and never from GetStdHandle', () => {
    const script = buildConsoleInputWriteCommand(4242, 'hello', false) as string
    expect(script).toContain("CreateFileW('CONIN$'")
    expect(script).not.toContain('GetStdHandle')
  })

  it('carries the text only as base64, never as text a tokenizer could reach', () => {
    const script = buildConsoleInputWriteCommand(4242, 'drop the tunnel', false) as string
    expect(script).not.toContain('drop the tunnel')
    expect(payloadOf(script)).toBe('drop the tunnel')
  })

  it.each([
    ["it's done", "it's done"],
    ['say ‘go’ now', 'say ‘go’ now'],
    ['a ‚low‛ quote', 'a ‚low‛ quote'],
    ["'; Remove-Item C:\\ #", "'; Remove-Item C:\\ #"],
    ["@'\nexit\n'@", "@' exit '@"],
    ['back`tick $(whoami)', 'back`tick $(whoami)']
  ])('survives %j without any of it reaching PowerShell as code', (input, expected) => {
    const script = buildConsoleInputWriteCommand(4242, input, false) as string
    expect(payloadOf(script)).toBe(expected)
    // The one quoted region in the script is the base64 blob, so nothing the
    // payload contained can close a literal or open a subexpression.
    const blob = /FromBase64String\('([^']*)'\)/.exec(script)?.[1] ?? ''
    expect(blob).toMatch(/^[A-Za-z0-9+/=]*$/)
  })

  it('flattens the message to one line, as a console has no literal newline', () => {
    const script = buildConsoleInputWriteCommand(4242, 'first\nsecond\r\nthird', false) as string
    expect(payloadOf(script)).toBe('first second third')
  })

  it('appends Enter as its own record pair only when asked', () => {
    const withEnter = buildConsoleInputWriteCommand(4242, 'go', true) as string
    const without = buildConsoleInputWriteCommand(4242, 'go', false) as string
    expect(withEnter).toContain('$units.Add([char]13)')
    expect(without).not.toContain('$units.Add([char]13)')
    // Enter rides outside the payload, so a message can never submit itself.
    expect(payloadOf(withEnter)).toBe('go')
    expect(payloadOf(without)).toBe('go')
  })

  it('gives the Enter record VK_RETURN and every text record none', () => {
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    expect(script).toContain('if ($unit -eq [char]13) { 13 } else { 0 }')
  })

  it('sizes the buffer at 20 bytes per record, two records per code unit', () => {
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    expect(script).toContain('New-Object byte[] ($units.Count * 40)')
    expect(script).toContain('$offset += 20')
  })

  it('counts records rather than bytes in nLength', () => {
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    expect(script).toContain('$expected = [uint32]($units.Count * 2)')
    expect(script).toContain('WriteConsoleInputW($conin, $buffer, $expected, [ref]$written)')
  })

  it('spells GENERIC_READ|GENERIC_WRITE in decimal, which PowerShell 5.1 needs', () => {
    const script = buildConsoleInputWriteCommand(4242, 'go', false) as string
    expect(script).toContain('3221225472')
    expect(script).not.toContain('0xC0000000')
  })

  it('imports no API that could move the foreground or press a key', () => {
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    for (const forbidden of [
      'SetForegroundWindow',
      'ShowWindow',
      'AttachThreadInput',
      'GetForegroundWindow',
      'SendKeys',
      'SendInput',
      'keybd_event',
      'System.Windows.Forms'
    ]) {
      expect(script).not.toContain(forbidden)
    }
  })

  it('detaches on the prologue and on every path that held a console', () => {
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    // Three CALL sites, counted past the P/Invoke declaration of the same name:
    // the prologue, the CONIN$ failure exit, and the success path. The attach
    // failure needs none — it holds no console to give back.
    expect(script.match(/\[Win32\.ConsoleInput\]::FreeConsole\(\)/g)?.length).toBe(3)
    expect(script).toContain('exit 2')
    expect(script).toContain('exit 3')
    expect(script).toContain('exit 4')
  })

  it('is stable for the same arguments', () => {
    expect(buildConsoleInputWriteCommand(7, 'same', true)).toBe(
      buildConsoleInputWriteCommand(7, 'same', true)
    )
  })
})
