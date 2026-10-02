import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { canonicalMinePath, caseFoldFor } from '../domain/minePath'
import {
  VOLUME_CASE_TTL_MS,
  statIdentity,
  volumeRulesFor,
  type FileIdentity,
  type HostOs,
  type IdentityReader
} from './volumeCase'

// S-030-1 passed (spike-results/S-030-1.md, Decision): the rules probe the folder itself, on every
// OS, with a case-swapped stat of the nearest cased component. These cases drive the detection
// over a synthetic volume, so a Windows, macOS or Linux rule is asserted on any host.

const OSES: readonly HostOs[] = ['win32', 'darwin', 'linux']

const pathOf = (os: HostOs): typeof posix => (os === 'win32' ? win32 : posix)

/** A synthetic root per OS (privacy-guard: no real user, home or host name). */
const rootOf = (os: HostOs): string => (os === 'win32' ? 'C:\\src' : '/src')

/**
 * A volume of `files` (path → inode, all on one device) whose `folding` directories compare names
 * without case. Every identity read is recorded.
 */
function syntheticVolume(
  os: HostOs,
  files: Map<string, bigint>,
  folding: readonly string[]
): { identityOf: IdentityReader; reads: string[] } {
  const path = pathOf(os)
  const reads: string[] = []
  const identityOf = (file: string): Promise<FileIdentity | null> => {
    reads.push(file)
    const exact = files.get(file)
    if (exact !== undefined) return Promise.resolve({ dev: 1n, ino: exact })
    const dir = path.dirname(file)
    if (folding.includes(dir)) {
      const name = path.basename(file).toLowerCase()
      for (const [other, ino] of files) {
        if (path.dirname(other) === dir && path.basename(other).toLowerCase() === name) {
          return Promise.resolve({ dev: 1n, ino })
        }
      }
    }
    return Promise.resolve(null)
  }
  return { identityOf, reads }
}

function rulesOver(os: HostOs, files: Map<string, bigint>, folding: readonly string[]) {
  const clock = new FakeClock(0)
  const volume = syntheticVolume(os, files, folding)
  return { rules: volumeRulesFor(os, { identityOf: volume.identityOf, clock }), clock, ...volume }
}

describe('volumeRulesFor', () => {
  it('[S-030-1] on macOS and Linux a folder the detection finds case-sensitive stays unfolded, and two case spellings stay two mine keys', async () => {
    for (const os of ['darwin', 'linux'] as const) {
      const { rules } = rulesOver(os, new Map([['/src/Repo', 1n]]), [])
      const volume = await rules.volumeCase('/src/Repo')
      const caseFold = caseFoldFor(volume)

      expect({ os, style: rules.style, volume }).toEqual({
        os,
        style: 'posix',
        volume: 'case-sensitive'
      })
      expect(canonicalMinePath('/src/Repo', { style: rules.style, caseFold })).not.toBe(
        canonicalMinePath('/src/repo', { style: rules.style, caseFold })
      )
    }
  })

  it('[S-030-1] a Windows folder the detection finds folding is case-insensitive and two case spellings give one mine key', async () => {
    const { rules } = rulesOver('win32', new Map([['C:\\src\\Repo', 1n]]), ['C:\\src'])
    const volume = await rules.volumeCase('C:\\src\\Repo')
    const caseFold = caseFoldFor(volume)

    expect({ style: rules.style, volume }).toEqual({ style: 'win32', volume: 'case-insensitive' })
    expect(canonicalMinePath('C:\\src\\Repo', { style: rules.style, caseFold })).toBe(
      canonicalMinePath('c:\\SRC\\repo', { style: rules.style, caseFold })
    )
  })

  it('[S-030-1] every OS, Windows included, folds a folder only where the detection finds that the folder folds', async () => {
    for (const os of OSES) {
      const path = pathOf(os)
      const folds = path.join(rootOf(os), 'folds')
      const exact = path.join(rootOf(os), 'exact')
      const files = new Map([
        [path.join(folds, 'Repo'), 1n],
        [path.join(exact, 'Repo'), 2n]
      ])
      const { rules } = rulesOver(os, files, [folds])

      expect([os, await rules.volumeCase(path.join(folds, 'Repo'))]).toEqual([
        os,
        'case-insensitive'
      ])
      // A Windows folder with the per-directory case-sensitive flag compares names exactly.
      expect([os, await rules.volumeCase(path.join(exact, 'Repo'))]).toEqual([os, 'case-sensitive'])
    }
  })

  it('[S-030-1] a path with no cased letter answers unknown without a read, and so does a path that cannot be read', async () => {
    for (const os of OSES) {
      const path = pathOf(os)
      const { rules, reads } = rulesOver(os, new Map(), [])
      const uncased = os === 'win32' ? 'C:\\1\\2' : '/1/2'

      expect([os, await rules.volumeCase(uncased)]).toEqual([os, 'unknown'])
      expect(reads, 'nothing to probe means nothing is read').toEqual([])
      expect([os, await rules.volumeCase(path.join(rootOf(os), 'Gone'))]).toEqual([os, 'unknown'])
    }
  })

  it('[S-030-1] identities compare as bigint: two file indexes that differ only past 2^53 are two folders', async () => {
    const big = 2n ** 60n
    const identityOf = (file: string): Promise<FileIdentity | null> =>
      Promise.resolve({ dev: 7n, ino: file.endsWith('Repo') ? big : big + 1n })
    const rules = volumeRulesFor('win32', { identityOf, clock: new FakeClock(0) })

    await expect(rules.volumeCase('C:\\src\\Repo')).resolves.toBe('case-sensitive')
  })

  it('[S-030-1] an answer is cached per directory for 30 s, never per device', async () => {
    const files = new Map([
      ['/a/One', 1n],
      ['/a/Two', 2n],
      ['/b/Three', 3n]
    ])
    const { rules, reads, clock } = rulesOver('linux', files, ['/a'])

    await expect(rules.volumeCase('/a/One')).resolves.toBe('case-insensitive')
    expect(reads).toHaveLength(2)
    // A second folder in the same directory reuses that directory's answer.
    await expect(rules.volumeCase('/a/Two')).resolves.toBe('case-insensitive')
    expect(reads).toHaveLength(2)
    // A directory on the same device has its own answer.
    await expect(rules.volumeCase('/b/Three')).resolves.toBe('case-sensitive')
    expect(reads).toHaveLength(4)
    // The answer is trusted as long as the resolver's cache (ADR-030 item 4), then probed again.
    clock.advance(VOLUME_CASE_TTL_MS - 1)
    await rules.volumeCase('/a/Two')
    expect(reads).toHaveLength(4)
    clock.advance(1)
    await expect(rules.volumeCase('/a/Two')).resolves.toBe('case-insensitive')
    expect(reads).toHaveLength(6)
  })

  it('[S-030-1] an unreadable answer is not cached: the directory is probed again on the next call', async () => {
    const files = new Map<string, bigint>()
    const { rules, reads } = rulesOver('darwin', files, ['/c'])

    await expect(rules.volumeCase('/c/Late')).resolves.toBe('unknown')
    files.set('/c/Late', 9n)
    await expect(rules.volumeCase('/c/Late')).resolves.toBe('case-insensitive')
    expect(reads).toEqual(['/c/Late', '/c/Late', '/c/lATE'])
  })
})

describe('statIdentity', () => {
  it('[S-030-1] reads device and inode as bigint, and null for a path that is not there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwarfai-ident-'))
    try {
      const identity = await statIdentity(dir)

      expect(typeof identity?.dev).toBe('bigint')
      expect(typeof identity?.ino).toBe('bigint')
      await expect(statIdentity(join(dir, 'missing'))).resolves.toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
