import { describe, expect, it } from 'vitest'
import {
  buildConsoleInputSequenceCommand,
  buildConsoleInputWriteCommand,
  consoleWriteFailureFor
} from './consoleInputWrite'
/* --- The script's own command line (#431) — one block, appended ------------ */
import { boundedChunks } from '../../shared/consoleText'
import { MAX_CONSOLE_TEXT_CHARS, WINDOWS_COMMAND_LINE_LIMIT } from '../domain/types'
/* --- end of the #431 block ------------------------------------------------- */

/**
 * The builder's own `CHUNK_SPLIT_DELAY_MS` is not exported — pinned here as the
 * value the 2026-09-16 measurement table settled on (0, 50 and 150 ms all
 * submitted; 50 is the one shipped), so a change to it fails a named test
 * rather than surprising whoever reads the script (#404).
 *
 * RENAMED with the constant for #402: the same margin now sits between every
 * pair of chunks in a sequence, not only between a message and its Enter.
 */
const EXPECTED_CHUNK_SPLIT_DELAY_MS = 50

/** The VT "cursor right" sequence that confirms a multi-select picker (#402). */
const CURSOR_RIGHT = '\u001b[C'

/** Read back the FIRST base64 payload the script carries, as the text it decodes to. */
function payloadOf(script: string): string {
  const blob = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(script)?.[1]
  if (blob === undefined) throw new Error('no base64 payload in the script')
  return Buffer.from(blob, 'base64').toString('utf16le')
}

/** Every chunk the script carries, in the order it writes them (#402). */
function payloadsOf(script: string): string[] {
  return [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map((match) =>
    Buffer.from(match[1] ?? '', 'base64').toString('utf16le')
  )
}

/**
 * The sequence builder (#402), which is the one the message path now calls
 * through: a list of code-unit chunks, each written in its OWN
 * `WriteConsoleInputW` call, the measured split delay between them.
 *
 * It exists because the question picker's answer is a SEQUENCE — toggles, then
 * a confirmation, then an accept — and #404 had already proved that a chunk
 * reads as a keystroke only when it arrives in a call of its own. Writing that
 * as a second builder beside this one would have meant two copies of the same
 * PowerShell; `buildConsoleInputWriteCommand` is a thin caller instead.
 */
describe('buildConsoleInputSequenceCommand', () => {
  it('refuses a pid that cannot name a process', () => {
    // The same fail-closed guard the text builder has, for the same reason: a
    // script built around a junk pid attaches to whatever holds that number.
    expect(buildConsoleInputSequenceCommand(0, ['1'])).toBeNull()
    expect(buildConsoleInputSequenceCommand(-1, ['1'])).toBeNull()
    expect(buildConsoleInputSequenceCommand(1.5, ['1'])).toBeNull()
    expect(buildConsoleInputSequenceCommand(Number.NaN, ['1'])).toBeNull()
  })

  it('refuses a sequence with nothing in it', () => {
    expect(buildConsoleInputSequenceCommand(4242, [])).toBeNull()
  })

  it('refuses an empty chunk, which would spend a call writing no records', () => {
    expect(buildConsoleInputSequenceCommand(4242, [''])).toBeNull()
    expect(buildConsoleInputSequenceCommand(4242, ['1', '', '\r'])).toBeNull()
  })

  it('writes one WriteConsoleInputW call per chunk, in order, with the delay between', () => {
    // The measured multi-select answer of #402: two toggles, the VT cursor-right
    // that opens the summary, then Enter. Each is its own call because a chunk
    // arriving inside another chunk's call reads as pasted content (#404).
    const script = buildConsoleInputSequenceCommand(4242, ['1', '3', CURSOR_RIGHT, '\r']) as string
    expect(payloadsOf(script)).toEqual(['1', '3', CURSOR_RIGHT, '\r'])
    expect(script.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(4)
    expect(
      script.match(new RegExp(`Start-Sleep -Milliseconds ${EXPECTED_CHUNK_SPLIT_DELAY_MS}`, 'g'))
        ?.length
    ).toBe(3)
  })

  it('keeps every chunk in its own buffer, so no two can share a call', () => {
    const script = buildConsoleInputSequenceCommand(4242, ['1', '\r']) as string
    const first = script.indexOf(
      'WriteConsoleInputW($conin, $buffer0, [uint32]($units0.Count * 2), [ref]$written0)'
    )
    const sleep = script.indexOf(`Start-Sleep -Milliseconds ${EXPECTED_CHUNK_SPLIT_DELAY_MS}`)
    const second = script.indexOf(
      'WriteConsoleInputW($conin, $buffer1, [uint32]($units1.Count * 2), [ref]$written1)'
    )
    expect(first).toBeGreaterThan(-1)
    expect(sleep).toBeGreaterThan(first)
    expect(second).toBeGreaterThan(sleep)
  })

  it('sleeps before no chunk but the first, and not at all for a lone one', () => {
    const lone = buildConsoleInputSequenceCommand(4242, ['\r']) as string
    expect(lone.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(1)
    expect(lone).not.toContain('Start-Sleep')
  })

  it('carries an escape sequence verbatim, since a VT chunk is not text to flatten', () => {
    // Measured 2026-09-16: `ESC [ C` as three ordinary text records confirms a
    // multi-select picker. None of the three is whitespace, but flattening is
    // the caller's job either way — this builder must not touch a chunk.
    const script = buildConsoleInputSequenceCommand(4242, [CURSOR_RIGHT]) as string
    expect(payloadsOf(script)).toEqual(['\u001b[C'])
    expect([...CURSOR_RIGHT].map((unit) => unit.codePointAt(0))).toEqual([27, 91, 67])
  })

  it('gives a carriage-return record VK_RETURN and every other record none', () => {
    // One record-building routine for every chunk, so the Enter chunk earns its
    // virtual key from the same line the text records are denied one by.
    const script = buildConsoleInputSequenceCommand(4242, ['1', '\r']) as string
    expect(script).toContain('if ($unit -eq [char]13) { 13 } else { 0 }')
    expect(script.match(/function New-InputBuffer/g)?.length).toBe(1)
  })

  it('counts records rather than bytes in nLength, for every chunk', () => {
    const script = buildConsoleInputSequenceCommand(4242, ['1', '\r']) as string
    expect(script).toContain('$expected += [uint32]($units0.Count * 2)')
    expect(script).toContain('$expected += [uint32]($units1.Count * 2)')
  })

  it('attaches to the pid, frees first, and takes the handle from CONIN$', () => {
    const script = buildConsoleInputSequenceCommand(4242, ['1']) as string
    expect(script.indexOf('FreeConsole()')).toBeLessThan(script.indexOf('AttachConsole('))
    expect(script).toContain('AttachConsole(4242)')
    expect(script).toContain("CreateFileW('CONIN$'")
    expect(script).not.toContain('GetStdHandle')
  })

  it('imports no API that could move the foreground or press a key', () => {
    // The whole point of this route: an answer reaches the session's own console
    // and never the foreground, so nothing here may be able to raise a window.
    const script = buildConsoleInputSequenceCommand(4242, ['1', CURSOR_RIGHT, '\r']) as string
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

  it('carries every chunk as base64 only, never as text a tokenizer could reach', () => {
    const script = buildConsoleInputSequenceCommand(4242, ["'; Remove-Item C:\\ #"]) as string
    expect(script).not.toContain('Remove-Item')
    expect(payloadsOf(script)).toEqual(["'; Remove-Item C:\\ #"])
  })

  it('keeps the three measured exit codes, which the sequence does not change', () => {
    const script = buildConsoleInputSequenceCommand(4242, ['1', '\r']) as string
    expect(script).toContain('exit 2')
    expect(script).toContain('exit 3')
    expect(script).toContain('exit 4')
    expect(script.match(/\[Win32\.ConsoleInput\]::FreeConsole\(\)/g)?.length).toBe(3)
  })

  it('is stable for the same arguments', () => {
    expect(buildConsoleInputSequenceCommand(7, ['1', '\r'])).toBe(
      buildConsoleInputSequenceCommand(7, ['1', '\r'])
    )
  })
})

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
    // AMENDED for #402: the Enter is a CHUNK now rather than a list built from
    // `[char]13` in the script, so what this reads back is the sequence the
    // wrapper hands down — one chunk, and that chunk a carriage return. The
    // shape it pins is unchanged: one call, and no sleep in front of it (#404).
    const script = buildConsoleInputWriteCommand(4242, '', true) as string
    expect(script).not.toBeNull()
    expect(payloadsOf(script)).toEqual(['\r'])
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
    // AMENDED for #402 with the test above: an Enter is a second CHUNK now, so
    // its presence is read off the sequence rather than off a script variable.
    // What it pins is untouched — Enter rides outside the text's own payload,
    // so a message can never submit itself.
    const withEnter = buildConsoleInputWriteCommand(4242, 'go', true) as string
    const without = buildConsoleInputWriteCommand(4242, 'go', false) as string
    expect(payloadsOf(withEnter)).toEqual(['go', '\r'])
    expect(payloadsOf(without)).toEqual(['go'])
  })

  it('never puts the Enter record in the text buffer it builds from', () => {
    // #404: the payload's own chunk must never carry char 13, because that
    // chunk is what the FIRST call writes — the one a live TUI cannot read as a
    // submit no matter what it contains.
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    expect(payloadOf(script)).not.toContain('\r')
  })

  it('writes the text and the Enter as two separate WriteConsoleInputW calls, text first, sleep between', () => {
    // #404: one call reads as a paste to a live Claude Code TUI and a
    // carriage return inside it is line content, not a submit — only a
    // SECOND, separate call is read as a keystroke. AMENDED for #402 for the
    // buffer names alone: the two calls, their order and the sleep between them
    // are exactly what they were.
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    const textCallIndex = script.indexOf('WriteConsoleInputW($conin, $buffer0')
    const sleepIndex = script.indexOf(`Start-Sleep -Milliseconds ${EXPECTED_CHUNK_SPLIT_DELAY_MS}`)
    const enterCallIndex = script.indexOf('WriteConsoleInputW($conin, $buffer1')
    expect(textCallIndex).toBeGreaterThan(-1)
    expect(sleepIndex).toBeGreaterThan(textCallIndex)
    expect(enterCallIndex).toBeGreaterThan(sleepIndex)
    expect(script.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(2)
  })

  it('makes one WriteConsoleInputW call and sleeps none when pressEnter is false', () => {
    // AMENDED for #402: the absent second buffer is what "no Enter" looks like
    // in the script now, where it used to be the absent `$enterUnits` list.
    const script = buildConsoleInputWriteCommand(4242, 'go', false) as string
    expect(script.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(1)
    expect(script).not.toContain('Start-Sleep')
    expect(script).not.toContain('$buffer1')
  })

  it('names the delay a constant carrying the measured margin, not a bare number', () => {
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    expect(script).toContain(`Start-Sleep -Milliseconds ${EXPECTED_CHUNK_SPLIT_DELAY_MS}`)
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
    // AMENDED for #402 for the chunk-indexed names; the arithmetic this guards
    // against — `nLength` counting bytes instead of records — is unchanged.
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    expect(script).toContain('$expected += [uint32]($units0.Count * 2)')
    expect(script).toContain('$expected += [uint32]($units1.Count * 2)')
    expect(script).toContain(
      'WriteConsoleInputW($conin, $buffer0, [uint32]($units0.Count * 2), [ref]$written0)'
    )
    expect(script).toContain(
      'WriteConsoleInputW($conin, $buffer1, [uint32]($units1.Count * 2), [ref]$written1)'
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

  /*
   * Issue #425: one `WriteConsoleInput` call carrying a long message loses its
   * own beginning between ConPTY's translation and a live Claude Code TUI's
   * reader, and a bounded chunk does not (measured 2026-09-16,
   * docs/console-hosting.md §6). The split belongs here, where the message
   * path's chunk list is built, so every caller of this wrapper — a message,
   * and #203's permission digit — benefits without the sequence builder itself
   * knowing what a chunk means.
   */
  it('splits a long message into bounded chunks before Enter, none over the bound', () => {
    const text = 'a'.repeat(1_500)
    const script = buildConsoleInputWriteCommand(4242, text, true) as string
    const payloads = payloadsOf(script)
    const enter = payloads.at(-1)
    const wordChunks = payloads.slice(0, -1)
    expect(enter).toBe('\r')
    // 500 is MAX_CONSOLE_CHUNK_CODE_POINTS (shared/consoleText.ts) — pinned
    // independently in consoleText.test.ts, so this only asserts the split
    // happened, not the exact ceiling value.
    for (const chunk of wordChunks) expect(chunk.length).toBeLessThanOrEqual(500)
    expect(wordChunks.length).toBeGreaterThan(1)
    expect(wordChunks.join('')).toBe(text)
    // One WriteConsoleInputW call per chunk, Enter included, each its own —
    // #404's rule holds for every chunk of a message, not only its first.
    expect(script.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(wordChunks.length + 1)
  })

  it('never splits a long message inside a surrogate pair', () => {
    // 700 emoji is 700 code points — over the 500-code-point bound, so this
    // must split — and 1,400 UTF-16 code units; a boundary landing inside a
    // pair would show up as an odd-length chunk.
    const text = '🙂'.repeat(700)
    const script = buildConsoleInputWriteCommand(4242, text, false) as string
    const chunks = payloadsOf(script)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length % 2).toBe(0)
    expect(chunks.join('')).toBe(text)
  })

  it('keeps a short message a single chunk, exactly as before the fix', () => {
    const script = buildConsoleInputWriteCommand(4242, 'go', true) as string
    expect(payloadsOf(script)).toEqual(['go', '\r'])
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

/* --- The script's own command line (#431) — one block, appended ------------ */

/*
 * Issue #431's finding, and the reason the console tier carries a lower ceiling
 * than the wire: this script is not run from a file. `windowsTextDelivery.ts`
 * spawns it as `powershell.exe -NoProfile -NonInteractive -Command <script>`,
 * so the whole thing — the person's words inside it, base64 of UTF-16, plus six
 * lines of scaffolding per chunk — has to fit in one Windows command line.
 *
 * #425's own probes never found this because they ran the script from a FILE
 * (`powershell -File`), which has no such bound. Measured live 2026-09-16
 * against a real session (docs/console-hosting.md §6): 29,323 code points built
 * a 109,152-character command line and `spawn` threw ENAMETOOLONG in 2 ms
 * without reaching a console; 8,214 code points arrived whole.
 *
 * These are the guard on the derivation, not a second copy of it: if the script
 * grows, the first of them fails and MAX_CONSOLE_TEXT_CHARS has to come down.
 */
describe('the command line a console write is spawned with (#431)', () => {
  /** What Node puts on the command line for the shipped argv, script aside. */
  const ARGV_FIXED = '"powershell.exe" -NoProfile -NonInteractive -Command '.length

  /** The script as one quoted argv element: its own quotes are escaped. */
  function commandLineLength(script: string): number {
    return ARGV_FIXED + script.length + (script.match(/"/g) ?? []).length + 2
  }

  it('fits a message at the console ceiling, with the Enter that submits it', () => {
    const script = buildConsoleInputWriteCommand(4242, 'x'.repeat(MAX_CONSOLE_TEXT_CHARS), true)
    expect(script).not.toBeNull()
    expect(commandLineLength(script!)).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT)
  })

  it('leaves room for five attached paths at the same ceiling', () => {
    // The ceiling reserves this rather than shrinking as chips appear, so the
    // reservation has to be real — see CONSOLE_SCRIPT_ATTACHMENT_CHARS.
    const paths = Array.from(
      { length: 5 },
      (_, index) => `\u001b[200~C:\\${'d'.repeat(250)}\\image-${index}.png\u001b[201~`
    )
    const script = buildConsoleInputSequenceCommand(4242, [
      ...paths,
      ...boundedChunks('x'.repeat(MAX_CONSOLE_TEXT_CHARS)),
      '\r'
    ])
    expect(script).not.toBeNull()
    expect(commandLineLength(script!)).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT)
  })

  it('would overflow that command line well before thirty thousand characters', () => {
    // The measurement this ceiling exists for: the builder happily produces the
    // script, and it is the SPAWN that refuses it — with no exit code, so no
    // tier retries and the panel has to refuse first.
    const script = buildConsoleInputWriteCommand(4242, 'x'.repeat(30_000), true)
    expect(script).not.toBeNull()
    expect(commandLineLength(script!)).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT * 3)
  })
})
/* --- end of the #431 block ------------------------------------------------- */
