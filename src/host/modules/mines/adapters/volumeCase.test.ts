import { describe, expect, it } from 'vitest'
import { canonicalMinePath, caseFoldFor } from '../domain/minePath'
import { volumeRulesFor } from './volumeCase'

describe('volumeRulesFor', () => {
  it('[S-030-1] while S-030-1 has not passed, a macOS or Linux volume is unknown and two case spellings stay two mine keys', async () => {
    for (const os of ['darwin', 'linux'] as const) {
      const rules = volumeRulesFor(os)
      const volume = await rules.volumeCase('/src/Repo')
      const caseFold = caseFoldFor(volume)

      expect({ os, style: rules.style, volume }).toEqual({ os, style: 'posix', volume: 'unknown' })
      expect(canonicalMinePath('/src/Repo', { style: rules.style, caseFold })).not.toBe(
        canonicalMinePath('/src/repo', { style: rules.style, caseFold })
      )
    }
  })

  it('[S-030-1] a Windows volume is case-insensitive and two case spellings give one mine key', async () => {
    const rules = volumeRulesFor('win32')
    const volume = await rules.volumeCase('C:\\src\\Repo')
    const caseFold = caseFoldFor(volume)

    expect({ style: rules.style, volume }).toEqual({ style: 'win32', volume: 'case-insensitive' })
    expect(canonicalMinePath('C:\\src\\Repo', { style: rules.style, caseFold })).toBe(
      canonicalMinePath('c:\\SRC\\repo', { style: rules.style, caseFold })
    )
  })
})
