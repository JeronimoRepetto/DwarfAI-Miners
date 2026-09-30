import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runFileSystemContract } from '../../kernel/testing/fileSystem.contract'
import { NodeFs, fsErrorOf } from './NodeFs'

describe('NodeFs', () => {
  // A fresh temporary root per test, removed afterwards (17 §1.3).
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  runFileSystemContract(async () => {
    const root = await mkdtemp(join(tmpdir(), 'dwarfai-nodefs-'))
    roots.push(root)
    return {
      fs: new NodeFs(),
      pathOf: (...segments) => join(root, ...segments),
      seed: async (path, content) => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content)
      }
    }
  })

  // The locked and disk-full codes cannot be produced on demand on every OS (17 O-17-03), so the
  // mapping itself is pinned here; the fake scripts the same codes to the same causes.
  it('[ADR-004] an OS error code maps to its typed cause, never to its message', () => {
    const osError = (code: string): Error =>
      Object.assign(new Error(code + ': private path'), { code })
    expect(fsErrorOf(osError('ENOENT'))).toBe('not-found')
    expect(fsErrorOf(osError('ENOTDIR'))).toBe('not-found')
    expect(fsErrorOf(osError('ENOSPC'))).toBe('no-space')
    expect(fsErrorOf(osError('EBUSY'))).toBe('busy')
    expect(fsErrorOf(osError('EPERM'))).toBe('access-denied')
    expect(fsErrorOf(osError('EACCES'))).toBe('access-denied')
    expect(fsErrorOf(osError('EISDIR'))).toBe('io')
    expect(fsErrorOf(new Error('no code'))).toBe('io')
    expect(fsErrorOf(null)).toBe('io')
  })
})
