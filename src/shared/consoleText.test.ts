import { describe, expect, it } from 'vitest'
import { MAX_CONSOLE_CHUNK_CODE_POINTS, boundedChunks, normalizeConsoleText } from './consoleText'

describe('normalizeConsoleText', () => {
  it('collapses newlines so a multi-line message reads as one line', () => {
    expect(normalizeConsoleText('first line\nsecond line')).toBe('first line second line')
  })

  it('collapses CRLF, tabs and runs of whitespace into single spaces', () => {
    expect(normalizeConsoleText('a\r\n\r\nb\tc')).toBe('a b c')
  })

  it('trims the surrounding whitespace', () => {
    expect(normalizeConsoleText('  padded  ')).toBe('padded')
  })

  it('leaves an already-flat message unchanged', () => {
    expect(normalizeConsoleText('dig deeper')).toBe('dig deeper')
  })

  it('handles empty input', () => {
    expect(normalizeConsoleText('')).toBe('')
  })
})

/**
 * Issue #425: one `WriteConsoleInput` call carrying a long message loses its
 * own beginning somewhere between ConPTY's translation and a live Claude Code
 * TUI's reader, and a bounded chunk does not — measured 2026-09-16,
 * `docs/console-hosting.md` §6. `MAX_CONSOLE_CHUNK_CODE_POINTS` is the ceiling
 * that measurement settled on: below the largest size (800 code points) that
 * arrived whole 3/3, since three runs on one machine cannot stand in for every
 * load and terminal condition a real delivery meets.
 */
describe('MAX_CONSOLE_CHUNK_CODE_POINTS', () => {
  it('pins the measured constant, so a change here fails a named test rather than surprising a reader', () => {
    expect(MAX_CONSOLE_CHUNK_CODE_POINTS).toBe(500)
  })
})

describe('boundedChunks', () => {
  it('returns no chunks at all for empty text, never an empty chunk', () => {
    expect(boundedChunks('')).toEqual([])
  })

  it('keeps a short message as a single chunk, exactly as today', () => {
    expect(boundedChunks('dig deeper')).toEqual(['dig deeper'])
  })

  it('keeps a message exactly at the bound as one chunk', () => {
    const text = 'x'.repeat(MAX_CONSOLE_CHUNK_CODE_POINTS)
    expect(boundedChunks(text)).toEqual([text])
  })

  it('splits a message one code point over the bound into two chunks, the second holding the rest', () => {
    const text = 'x'.repeat(MAX_CONSOLE_CHUNK_CODE_POINTS + 1)
    const chunks = boundedChunks(text)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(MAX_CONSOLE_CHUNK_CODE_POINTS)
    expect(chunks[1]).toBe('x')
  })

  it('splits a 1,500-code-point message into the expected chunks, none over the bound', () => {
    const text = 'a'.repeat(1_500)
    const chunks = boundedChunks(text)
    expect(chunks).toHaveLength(Math.ceil(1_500 / MAX_CONSOLE_CHUNK_CODE_POINTS))
    for (const chunk of chunks)
      expect(chunk.length).toBeLessThanOrEqual(MAX_CONSOLE_CHUNK_CODE_POINTS)
    expect(chunks.join('')).toBe(text)
  })

  it('never splits inside a surrogate pair: every chunk of an emoji-only text is whole code points', () => {
    // Each ⛏ is one surrogate pair — two UTF-16 code units, one code point —
    // so a boundary that fell inside one would produce an odd-length chunk
    // with a lone unpaired surrogate.
    const emoji = '⛏️'
    const text = emoji.repeat(400)
    const chunks = boundedChunks(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length % 2).toBe(0)
      expect(Array.from(chunk).every((point) => [...point].length <= 2)).toBe(true)
    }
    // Round-trips: concatenating every chunk reproduces the original text,
    // with nothing lost, duplicated or reordered at a boundary.
    expect(chunks.join('')).toBe(text)
  })
})

/* --- A very long message's chunk plan (#431) — one block, appended --------- */

/*
 * Issue #431 asked what happens to a 30,000-code-point message on the console
 * tier. The PLAN is fine and this pins it: the splitting rule has no ceiling of
 * its own, so the answer is simply "sixty calls", and the time that costs is
 * linear in the builder's own pause.
 *
 * What is NOT fine is downstream, and it is the reason the console gets a
 * tighter ceiling than the wire: every chunk becomes six lines of PowerShell
 * carrying its text as base64 of UTF-16, and the whole script is spawned in a
 * COMMAND LINE. Measured live 2026-09-16 (docs/console-hosting.md §6), a 29,323
 * code-point message built a 109,152-character command line and the spawn was
 * refused with ENAMETOOLONG. See MAX_CONSOLE_TEXT_CHARS in shared/contracts.ts
 * — that is the number the panel refuses on, and this file's rule is what it
 * was derived against.
 */
describe('boundedChunks: a thirty-thousand-point message', () => {
  const NUMBERED = Array.from(
    { length: 750 },
    (_, index) => `L${String(index + 1).padStart(4, '0')} línea de prueba con emoji 🙂 y ñandú.`
  ).join(' ')

  it('splits it into exactly the calls its length asks for, and no cap of its own', () => {
    const points = Array.from(NUMBERED).length
    expect(points).toBeGreaterThan(30_000)
    const chunks = boundedChunks(NUMBERED)
    expect(chunks).toHaveLength(Math.ceil(points / MAX_CONSOLE_CHUNK_CODE_POINTS))
  })

  it('loses nothing across sixty-odd boundaries, emoji included', () => {
    expect(boundedChunks(NUMBERED).join('')).toBe(NUMBERED)
  })

  it('never splits a surrogate pair, however many chunks it takes', () => {
    for (const chunk of boundedChunks(NUMBERED)) {
      expect(Array.from(chunk).length).toBeLessThanOrEqual(MAX_CONSOLE_CHUNK_CODE_POINTS)
      // A lone surrogate would survive neither of these: Array.from walks code
      // points, so a split pair would show up as two unpaired code units.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chunk)).toBe(false)
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk)).toBe(false)
    }
  })
})
/* --- end of the #431 block ------------------------------------------------- */
