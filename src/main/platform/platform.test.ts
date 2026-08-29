import { describe, expect, it } from 'vitest'
import { isCaseInsensitiveFs, normalizePathKey, normalizePlatform } from './platform'

describe('normalizePlatform', () => {
  it('keeps the two platforms with their own native adapters', () => {
    expect(normalizePlatform('win32')).toBe('win32')
    expect(normalizePlatform('darwin')).toBe('darwin')
  })

  it('maps linux to itself', () => {
    expect(normalizePlatform('linux')).toBe('linux')
  })

  it('treats every other POSIX-ish platform as linux', () => {
    // freebsd/openbsd/aix/sunos all run the generic POSIX adapters. Guessing
    // "linux" is strictly better than throwing: the app still starts, and the
    // POSIX adapters degrade to "unsupported" wherever they cannot deliver.
    for (const raw of ['freebsd', 'openbsd', 'netbsd', 'aix', 'sunos', 'android', 'haiku']) {
      expect(normalizePlatform(raw)).toBe('linux')
    }
  })
})

describe('isCaseInsensitiveFs', () => {
  it('reports Windows and macOS as case-insensitive', () => {
    expect(isCaseInsensitiveFs('win32')).toBe(true)
    expect(isCaseInsensitiveFs('darwin')).toBe(true)
  })

  it('reports Linux as case-sensitive', () => {
    // Two projects at /home/j/Proj and /home/j/proj are genuinely different
    // directories on Linux; folding their case would merge two mines into one.
    expect(isCaseInsensitiveFs('linux')).toBe(false)
  })
})

describe('normalizePathKey', () => {
  it('folds separators and case on Windows', () => {
    expect(normalizePathKey('C:/Users/Jeron/Proj', 'win32')).toBe('c:\\users\\jeron\\proj')
    expect(normalizePathKey('C:\\Users\\Jeron\\Proj', 'win32')).toBe('c:\\users\\jeron\\proj')
  })

  it('folds only case on macOS, leaving POSIX separators alone', () => {
    expect(normalizePathKey('/Users/Jeron/Proj', 'darwin')).toBe('/users/jeron/proj')
  })

  it('changes nothing on Linux', () => {
    expect(normalizePathKey('/home/jeron/Proj', 'linux')).toBe('/home/jeron/Proj')
    expect(normalizePathKey('/home/jeron/proj', 'linux')).toBe('/home/jeron/proj')
  })

  it('keeps two Linux paths that differ only in case distinct', () => {
    expect(normalizePathKey('/home/j/Proj', 'linux')).not.toBe(
      normalizePathKey('/home/j/proj', 'linux')
    )
  })
})
