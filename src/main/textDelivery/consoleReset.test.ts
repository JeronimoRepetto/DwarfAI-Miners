import { describe, expect, it } from 'vitest'
import { buildConsoleResetCommand, CONSOLE_RESET_SEQUENCE } from './consoleReset'

/**
 * Read the base64-of-UTF-16 payload blob out of a built script, the same way
 * `chunksOf` in windowsTextDelivery.test.ts reads the message chunks out of
 * `consoleInputWrite.ts`'s scripts — the payload never appears in the script
 * as anything a tokenizer could reach, so this is the only honest way to read
 * it back.
 */
function payloadOf(script: string): string {
  const match = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(script)
  return Buffer.from(match?.[1] ?? '', 'base64').toString('utf16le')
}

/** The pids `AttachConsole` is asked for, in the order the script tries them. */
function attachOrderOf(script: string): number[] {
  return [...script.matchAll(/AttachConsole\((\d+)\)/g)].map((match) => Number(match[1]))
}

describe('CONSOLE_RESET_SEQUENCE', () => {
  it('is exactly the seven measured DECSET resets, in order, with no separators', () => {
    // Spelled out rather than built from a list, so a stray space or a
    // reordering shows up as a literal string mismatch rather than surviving
    // a join() that would have masked it.
    expect(CONSOLE_RESET_SEQUENCE).toBe(
      '\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1015l\u001b[?2004l\u001b[?25h'
    )
  })

  it('never carries ESC[?1049l — leaving the alternate screen is not this repair (#504)', () => {
    expect(CONSOLE_RESET_SEQUENCE).not.toContain('1049')
  })
})

describe('buildConsoleResetCommand', () => {
  it('returns null for an empty candidate list — nothing to attach to, so nothing runs', () => {
    expect(buildConsoleResetCommand([])).toBeNull()
  })

  it.each([
    ['zero', [0]],
    ['negative', [-4242]],
    ['a fraction', [4242.5]],
    ['not a real number', [Number.NaN]],
    ['unsafe past the float precision boundary', [2 ** 53]]
  ])(
    'returns null when a candidate pid is %s — fail-closed like the write-by-pid guard',
    (_label, pids) => {
      expect(buildConsoleResetCommand(pids)).toBeNull()
    }
  )

  it('returns null for the whole list when only one entry is invalid', () => {
    expect(buildConsoleResetCommand([4242, -1])).toBeNull()
  })

  it('builds a script that carries the exact measured reset sequence, undecodable as anything else', () => {
    const script = buildConsoleResetCommand([4242])
    expect(script).not.toBeNull()
    expect(payloadOf(script as string)).toBe(CONSOLE_RESET_SEQUENCE)
  })

  it('tries every candidate pid, in the order given', () => {
    const script = buildConsoleResetCommand([111, 222, 333]) as string
    expect(attachOrderOf(script)).toEqual([111, 222, 333])
  })

  it('writes through CONOUT$ with WriteConsoleW — a reset is output, never input (#504)', () => {
    const script = buildConsoleResetCommand([4242]) as string
    expect(script).toContain('CONOUT$')
    expect(script).toContain('WriteConsoleW')
    // The write-by-pid sibling's own handle and call must never appear here —
    // a reset written as key records would be typed by the shell, not obeyed.
    expect(script).not.toContain('CONIN$')
    expect(script).not.toContain('WriteConsoleInputW')
  })

  it('sets ENABLE_VIRTUAL_TERMINAL_PROCESSING only when GetConsoleMode reports it absent, and restores it after', () => {
    const script = buildConsoleResetCommand([4242]) as string
    expect(script).toContain('GetConsoleMode')
    expect(script).toContain('SetConsoleMode')
    // The measured mode was 7 (VT already on) with the flag bit 4; the guard
    // must read as "set it only if the bit is not already there".
    expect(script).toMatch(/-band 4\)\s*-eq 0/)
    // The prior mode is restored after the write, not left forced on for a
    // console this script does not own past the one write.
    expect(script).toMatch(/SetConsoleMode\(\$conout, \$originalMode\)/)
  })

  it('carries the numbered exit codes the caller must be able to read (#504)', () => {
    const script = buildConsoleResetCommand([4242]) as string
    expect(script).toContain('exit 2') // no candidate pid could be attached
    expect(script).toContain('exit 3') // CONOUT$ would not open
    expect(script).toContain('exit 4') // the write was short or refused
    expect(script).toContain('exit 0') // wrote it
  })

  it('uses the decimal GENERIC_READ_WRITE constant, never the signed-hex form PowerShell 5.1 mis-parses', () => {
    const script = buildConsoleResetCommand([4242]) as string
    expect(script).toContain('3221225472')
    expect(script).not.toMatch(/0xC0000000/i)
  })
})
