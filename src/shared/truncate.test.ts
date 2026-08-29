import { describe, expect, it } from 'vitest'
import { truncate } from './truncate'

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
