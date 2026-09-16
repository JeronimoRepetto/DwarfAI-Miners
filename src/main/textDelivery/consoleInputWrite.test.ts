import { describe, expect, it } from 'vitest'
import { buildConsoleInputWriteCommand, consoleWriteFailureFor } from './consoleInputWrite'

/**
 * The builder's own `ENTER_SPLIT_DELAY_MS` is not exported — pinned here as the
 * value the 2026-09-16 measurement table settled on (0, 50 and 150 ms all
 * submitted; 50 is the one shipped), so a change to it fails a named test
 * rather than surprising whoever reads the script (#404).
 */
const EXPECTED_ENTER_SPLIT_DELAY_MS = 50

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
    const script = buildConsoleInputWriteCommand(4242, '', true) as string
    expect(script).not.toBeNull()
    expect(payloadOf(script)).toBe('')
    expect(script).toContain('$enterUnits.Add([char]13)')
    // A bare Enter has no text call to come after, so it is the ONE call this
    // builder ever makes with no sleep in front of it (#404).
    expect(script.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(1)
    expect(script).not.toContain('Start-Sleep')
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
    expect(withEnter).toContain('$enterUnits.Add([char]13)')
    expect(without).not.toContain('$enterUnits.Add([char]13)')
    // Enter rides outside the payload, so a message can never submit itself.
    expect(payloadOf(withEnter)).toBe('go')
    expect(payloadOf(without)).toBe('go')
  })

  it('never puts the Enter record in the text buffer it builds from', () => {
    // #404: the payload's own list must never carry char 13, because that list
    // is what the FIRST call writes — the one a live TUI cannot read as a
    // submit no matter what it contains.
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    expect(script).not.toContain('$textUnits.Add(')
    expect(payloadOf(script)).not.toContain('\r')
  })

  it('writes the text and the Enter as two separate WriteConsoleInputW calls, text first, sleep between', () => {
    // #404: one call reads as a paste to a live Claude Code TUI and a
    // carriage return inside it is line content, not a submit — only a
    // SECOND, separate call is read as a keystroke.
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    const textCallIndex = script.indexOf('WriteConsoleInputW($conin, $textBuffer')
    const sleepIndex = script.indexOf(`Start-Sleep -Milliseconds ${EXPECTED_ENTER_SPLIT_DELAY_MS}`)
    const enterCallIndex = script.indexOf('WriteConsoleInputW($conin, $enterBuffer')
    expect(textCallIndex).toBeGreaterThan(-1)
    expect(sleepIndex).toBeGreaterThan(textCallIndex)
    expect(enterCallIndex).toBeGreaterThan(sleepIndex)
    expect(script.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(2)
  })

  it('makes one WriteConsoleInputW call and sleeps none when pressEnter is false', () => {
    const script = buildConsoleInputWriteCommand(4242, 'go', false) as string
    expect(script.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(1)
    expect(script).not.toContain('Start-Sleep')
    expect(script).not.toContain('$enterUnits')
  })

  it('names the delay a constant carrying the measured margin, not a bare number', () => {
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    expect(script).toContain(`Start-Sleep -Milliseconds ${EXPECTED_ENTER_SPLIT_DELAY_MS}`)
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

  it('counts records rather than bytes in nLength, for both calls', () => {
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    expect(script).toContain('$expected += [uint32]($textUnits.Count * 2)')
    expect(script).toContain('$expected += [uint32]($enterUnits.Count * 2)')
    expect(script).toContain(
      'WriteConsoleInputW($conin, $textBuffer, [uint32]($textUnits.Count * 2), [ref]$textWritten)'
    )
    expect(script).toContain(
      'WriteConsoleInputW($conin, $enterBuffer, [uint32]($enterUnits.Count * 2), [ref]$enterWritten)'
    )
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

/*
 * The script's three exit codes are three different facts about a person's own
 * session, so they become three different sentences rather than one bare
 * non-zero (#371). The half of each answer that is NOT for the person is
 * `wroteNothing`: only a failure that provably reached no console may be
 * retried on another tier, which is what `TextDeliveryOutcome.neverStarted`
 * carries to the runtime.
 */
describe('consoleWriteFailureFor', () => {
  it('distinguishes the three measured failures by sentence', () => {
    const sentences = [2, 3, 4].map((code) => consoleWriteFailureFor(code).error)
    expect(new Set(sentences).size).toBe(3)
    for (const sentence of sentences) expect(sentence).not.toBe('')
  })

  it('says nothing was written for an attach that was refused, and for a console that would not open', () => {
    // Exit 2 is `AttachConsole` returning false — measured against a pid whose
    // session had ended — and exit 3 is `CONIN$` refusing to open. Neither
    // reached `WriteConsoleInput` at all.
    expect(consoleWriteFailureFor(2).wroteNothing).toBe(true)
    expect(consoleWriteFailureFor(3).wroteNothing).toBe(true)
  })

  it('never claims nothing was written for a short write', () => {
    // `EventsWritten` short of `nLength` means records DID go into the buffer;
    // a second delivery behind it would put part of the message in twice.
    expect(consoleWriteFailureFor(4).wroteNothing).toBe(false)
  })

  it('treats an exit code the script does not define as a write that may have landed', () => {
    // A PowerShell failure of its own (exit 1), or a shell that was killed:
    // nothing here can prove the buffer was untouched, so it must not say so.
    expect(consoleWriteFailureFor(1)).toMatchObject({ wroteNothing: false })
    expect(consoleWriteFailureFor(255).error).toBeTruthy()
  })
})
