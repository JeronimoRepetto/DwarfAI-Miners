import { describe, expect, it } from 'vitest'
import { normalizeConsoleText } from './consoleText'

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
