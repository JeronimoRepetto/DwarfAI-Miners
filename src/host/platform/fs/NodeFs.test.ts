import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runFileSystemContract } from '../../kernel/testing/fileSystem.contract'
import { NodeFs, atomicWriteModes, fsErrorOf, newDirMode } from './NodeFs'

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

  // ADDED for ISSUE-227 (foreman decision, 2026-10-16): a file the Host writes into another tool's folder may hold a
  // channel token (ADR-016 item 1), so a new file is owner-only and a replaced file keeps the person's own mode. The
  // decision is pinned here on every OS; `NodeFs.os.test.ts` proves it on a POSIX disk. Windows has no POSIX modes:
  // nothing changes there.
  it("[ADR-016] an atomic write creates a new file owner-only and keeps a replaced file's mode on POSIX, and changes nothing on Windows", () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(atomicWriteModes(null, platform)).toStrictEqual({ create: 0o600, chmod: null })
      expect(atomicWriteModes(0o100644, platform)).toStrictEqual({ create: 0o600, chmod: 0o644 })
      expect(atomicWriteModes(0o100600, platform)).toStrictEqual({ create: 0o600, chmod: 0o600 })
      expect(atomicWriteModes(0o104755, platform)).toStrictEqual({ create: 0o600, chmod: 0o4755 })
    }
    expect(atomicWriteModes(null, 'win32')).toStrictEqual({ create: 0o666, chmod: null })
    expect(atomicWriteModes(0o100444, 'win32')).toStrictEqual({ create: 0o666, chmod: null })
  })

  it('[ADR-016] a folder the Host makes is owner-only on POSIX, and made as before on Windows', () => {
    expect(newDirMode('linux')).toBe(0o700)
    expect(newDirMode('darwin')).toBe(0o700)
    expect(newDirMode('win32')).toBeUndefined()
  })
})
