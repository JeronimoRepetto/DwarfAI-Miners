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
