import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import { canonicalMinePath, caseFoldFor } from './minePath'

describe('canonicalMinePath (ADR-030 item 1, 06 §3)', () => {
  it('[US-MINES-006.AC07, INV-02] two spellings of one folder give one MinePath', () => {
    const windows = { style: 'win32', caseFold: true } as const
    const spellings = ['C:\\Work\\Repo', 'C:/Work/Repo', 'c:\\work\\repo\\', 'C:\\Work//Repo/']
    const keys = new Set(spellings.map((p) => canonicalMinePath(p, windows)))
    expect([...keys]).toEqual(['c:\\work\\repo'])

    const linux = { style: 'posix', caseFold: false } as const
    expect(canonicalMinePath('/home/j/repo/', linux)).toBe(
      canonicalMinePath('/home/j//repo', linux)
    )
    expect(canonicalMinePath('/home/j/repo/', linux)).toBe('/home/j/repo')
  })

  it('[ADR-030] case is folded on Windows and on a case-insensitive volume only', () => {
    // The fold decision: Windows always; POSIX only for a volume known to be case-insensitive.
    // An unknown volume is never folded (S-030-1 not passed: the conservative default).
    expect(caseFoldFor('win32', 'unknown')).toBe(true)
    expect(caseFoldFor('win32', 'case-sensitive')).toBe(true)
    expect(caseFoldFor('posix', 'case-insensitive')).toBe(true)
    expect(caseFoldFor('posix', 'case-sensitive')).toBe(false)
    expect(caseFoldFor('posix', 'unknown')).toBe(false)

    const mac = '/Users/j/Repo'
    expect(canonicalMinePath(mac, { style: 'posix', caseFold: true })).toBe('/users/j/repo')
    expect(canonicalMinePath(mac, { style: 'posix', caseFold: false })).toBe('/Users/j/Repo')
    // On POSIX a backslash is a filename character, never a separator.
    expect(canonicalMinePath('/srv/a\\b', { style: 'posix', caseFold: false })).toBe('/srv/a\\b')
  })

  it('[ADR-030] a root keeps its separator and a UNC prefix keeps its two', () => {
    expect(canonicalMinePath('/', { style: 'posix', caseFold: false })).toBe('/')
    expect(canonicalMinePath('C:\\', { style: 'win32', caseFold: true })).toBe('c:\\')
    expect(canonicalMinePath('//Server/Share/Repo/', { style: 'win32', caseFold: true })).toBe(
      '\\\\server\\share\\repo'
    )
  })

  it('[ADR-030] a path that is not absolute is refused as a programming error', () => {
    expect(() => canonicalMinePath('repo', { style: 'posix', caseFold: false })).toThrow(
      HostInvariantError
    )
    expect(() => canonicalMinePath('Work\\Repo', { style: 'win32', caseFold: true })).toThrow(
      HostInvariantError
    )
  })
})
