import { describe, expect, it } from 'vitest'
import { truncate, truncateTail } from './truncate'

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('returns text of exactly max length unchanged', () => {
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('cuts long text and appends a single ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello w…')
  })

  it('never exceeds max characters, ellipsis included', () => {
    for (const max of [2, 5, 20, 79, 80]) {
      expect(truncate('x'.repeat(200), max).length).toBeLessThanOrEqual(max)
    }
  })

  it('drops trailing whitespace before the ellipsis', () => {
    expect(truncate('hello   world', 8)).toBe('hello…')
  })

  it('returns an empty string for max <= 0', () => {
    expect(truncate('hello', 0)).toBe('')
    expect(truncate('hello', -3)).toBe('')
  })

  it('returns just the ellipsis for max 1 with longer text', () => {
    expect(truncate('hello', 1)).toBe('…')
  })

  it('handles empty input', () => {
    expect(truncate('', 10)).toBe('')
  })

  it('collapses newlines into spaces so bubbles stay single-line friendly', () => {
    expect(truncate('line one\nline two', 80)).toBe('line one line two')
  })
})

/*
 * ADDED for #635 (MESSAGE-QUESTIONS 23): a failed tool's own output is read from its END — its
 * last lines say why it stopped — and keeps its line breaks, for the notice title's tooltip.
 */
describe('truncateTail', () => {
  it('returns text within the bound unchanged, line breaks and all', () => {
    expect(truncateTail('one\ntwo\n', 10)).toBe('one\ntwo\n')
  })

  it('keeps the end, marking what it dropped from the front with one ellipsis', () => {
    expect(truncateTail('first line\nlast line', 10)).toBe('…last line')
    expect(truncateTail('x'.repeat(50), 10)).toHaveLength(10)
  })

  it('drops the blank space the cut leaves after its ellipsis', () => {
    expect(truncateTail('aaaa\n   tail', 8)).toBe('…tail')
  })

  it('never cuts a character in half', () => {
    expect(truncateTail('😀😀😀😀', 3)).toBe('…😀😀')
  })

  it('writes a Windows line break as one', () => {
    expect(truncateTail('one\r\ntwo', 20)).toBe('one\ntwo')
  })

  it('returns an empty string for max <= 0', () => {
    expect(truncateTail('hello', 0)).toBe('')
  })
})
