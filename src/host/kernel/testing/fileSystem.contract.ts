// The FileSystem conformance suite (16 §2.8, 16 §3 row `FileSystem`, 17 §1.3): run against FakeFs
// and against NodeFs over a per-test temporary directory. A fake that drifts from the disk makes
// every L2 test lie, so each case here holds for both.
import { describe, expect, it } from 'vitest'
import type { FileSystem } from '../ports/fileSystem'

export interface FileSystemSubject {
  fs: FileSystem
  /** A path under the subject's own empty root, built from path segments. */
  pathOf(...segments: string[]): string
  /** Puts a file on the subject's storage outside the port under test (parents included). */
  seed(path: string, content: string): Promise<void>
}

/** A write fault the fake injects on a chosen path (17 §1.10 CH-06, CH-07). */
export type ScriptedFsFault = 'ENOENT' | 'ENOSPC' | 'EBUSY' | 'EPERM' | 'EACCES'

export interface FaultyFileSystemSubject extends FileSystemSubject {
  /** Every later operation on `path` fails with `fault`, as the OS would report it. */
  scriptFault(path: string, fault: ScriptedFsFault): void
}

const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

export function runFileSystemContract(
  makeSubject: () => FileSystemSubject | Promise<FileSystemSubject>
): void {
  describe('FileSystem contract', () => {
    it('[ADR-004] reading a missing file yields the typed not-found result, never a throw', async () => {
      const { fs, pathOf, seed } = await makeSubject()
      await seed(pathOf('present', 'kept.txt'), 'kept')

      await expect(fs.readFile(pathOf('present', 'missing.txt'))).resolves.toEqual({
        ok: false,
        error: 'not-found'
      })
      await expect(fs.readFile(pathOf('absent', 'missing.txt'))).resolves.toEqual({
        ok: false,
        error: 'not-found'
      })
    })

    it('[ADR-004] a write then a read returns the same bytes; an atomic temp-and-rename write never leaves a partial file', async () => {
      const { fs, pathOf, seed } = await makeSubject()
      const target = pathOf('config', 'settings.json')
      await seed(target, '{"old":true,"padding":"a longer previous content than the new one"}')

      await expect(fs.writeFileAtomic(target, '{"new":1}')).resolves.toEqual({
        ok: true,
        value: undefined
      })
      const read = await fs.readFile(target)
      expect(read.ok && utf8(read.value)).toBe('{"new":1}')

      const bytes = new Uint8Array([0x00, 0xff, 0x7b, 0x0a, 0xc3, 0xa9])
      await expect(fs.writeFileAtomic(pathOf('config', 'blob.bin'), bytes)).resolves.toEqual({
        ok: true,
        value: undefined
      })
      const readBytes = await fs.readFile(pathOf('config', 'blob.bin'))
      expect(readBytes.ok && [...readBytes.value]).toEqual([...bytes])

      // Only the two targets remain: no temporary sibling survives a successful write.
      const listed = await fs.listDirWithSizes(pathOf('config'))
      expect(listed.ok && listed.value.map((entry) => entry.name).sort()).toEqual([
        'blob.bin',
        'settings.json'
      ])
    })

    it('[ADR-004] a failed atomic write is a typed error, leaves the target whole and no temporary file behind', async () => {
      const { fs, pathOf, seed } = await makeSubject()
      // The target is a directory, so the final rename cannot replace it on any OS.
      await seed(pathOf('work', 'occupied', 'inner.txt'), 'inner')
      await seed(pathOf('work', 'neighbour.txt'), 'neighbour')

      const written = await fs.writeFileAtomic(pathOf('work', 'occupied'), 'would replace a dir')
      expect(written.ok).toBe(false)

      const listed = await fs.listDirWithSizes(pathOf('work'))
      expect(listed.ok && listed.value.map((entry) => entry.name).sort()).toEqual([
        'neighbour.txt',
        'occupied'
      ])
      const inner = await fs.readFile(pathOf('work', 'occupied', 'inner.txt'))
      expect(inner.ok && utf8(inner.value)).toBe('inner')

      await expect(fs.writeFileAtomic(pathOf('nowhere', 'file.txt'), 'x')).resolves.toEqual({
        ok: false,
        error: 'not-found'
      })
      await expect(fs.exists(pathOf('nowhere'))).resolves.toBe(false)
    })

    it('[ADR-006] a bounded tail read returns at most the requested bytes from the end', async () => {
      const { fs, pathOf, seed } = await makeSubject()
      const log = pathOf('provider', 'session.jsonl')
      await seed(log, '{"n":1}\n{"n":2}\n{"n":3}\n')

      await expect(fs.readTextTail(log, 8)).resolves.toBe('{"n":3}\n')
      await expect(fs.readTextTail(log, 1)).resolves.toBe('\n')
      await expect(fs.readTextTail(log, 0)).resolves.toBe('')
      await expect(fs.readTextTail(log, 1_000)).resolves.toBe('{"n":1}\n{"n":2}\n{"n":3}\n')
      await expect(fs.readTextHead(log, 8)).resolves.toBe('{"n":1}\n')
    })

    it('[ADR-004] listing a directory returns names and sizes; a missing directory yields the typed not-found result', async () => {
      const { fs, pathOf, seed } = await makeSubject()
      await seed(pathOf('dir', 'a.txt'), 'abc')
      await seed(pathOf('dir', 'é.txt'), 'é')
      await seed(pathOf('dir', 'sub', 'deep.txt'), 'deep')

      const listed = await fs.listDirWithSizes(pathOf('dir'))
      expect(listed.ok).toBe(true)
      const entries = listed.ok ? listed.value : []
      const byName = new Map(entries.map((entry) => [entry.name, entry]))
      expect([...byName.keys()].sort()).toEqual(['a.txt', 'sub', 'é.txt'])
      expect(byName.get('a.txt')).toEqual({ name: 'a.txt', isDirectory: false, size: 3 })
      expect(byName.get('é.txt')).toEqual({ name: 'é.txt', isDirectory: false, size: 2 })
      expect(byName.get('sub')).toEqual({ name: 'sub', isDirectory: true, size: 0 })

      await expect(fs.listDirWithSizes(pathOf('dir', 'missing'))).resolves.toEqual({
        ok: false,
        error: 'not-found'
      })
    })
  })
}

/**
 * The fault cases (17 §1.10): fake only, because a real disk-full or exclusive-lock injector is
 * UNVERIFIED per OS (17 O-17-03). Run only by the double's runner.
 */
export function runFileSystemFaultContract(
  makeSubject: () => FaultyFileSystemSubject | Promise<FaultyFileSystemSubject>
): void {
  describe('FileSystem fault contract', () => {
    it('[FM-104, CH-06] a scripted ENOSPC on write surfaces as the typed error the caller branches on', async () => {
      const { fs, pathOf, seed, scriptFault } = await makeSubject()
      const target = pathOf('logs', 'host.log')
      await seed(target, 'previous line\n')
      scriptFault(target, 'ENOSPC')

      await expect(fs.writeFileAtomic(target, 'next line\n')).resolves.toEqual({
        ok: false,
        error: 'no-space'
      })
      // Nothing half-written (13 FM-104): the directory holds the target alone.
      const listed = await fs.listDirWithSizes(pathOf('logs'))
      expect(listed.ok && listed.value.map((entry) => entry.name)).toEqual(['host.log'])
    })

    it('[FM-125, CH-07] a scripted EBUSY or EPERM on a chosen path surfaces as its typed error', async () => {
      const { fs, pathOf, seed, scriptFault } = await makeSubject()
      const busy = pathOf('opencode', 'plugin.js')
      const denied = pathOf('opencode', 'config.json')
      const unreadable = pathOf('opencode', 'secret.json')
      const vanished = pathOf('opencode', 'gone.json')
      const free = pathOf('opencode', 'free.json')
      for (const path of [busy, denied, unreadable, vanished, free]) await seed(path, 'x')
      scriptFault(busy, 'EBUSY')
      scriptFault(denied, 'EPERM')
      scriptFault(unreadable, 'EACCES')
      scriptFault(vanished, 'ENOENT')

      await expect(fs.writeFileAtomic(busy, 'y')).resolves.toEqual({ ok: false, error: 'busy' })
      await expect(fs.writeFileAtomic(denied, 'y')).resolves.toEqual({
        ok: false,
        error: 'access-denied'
      })
      await expect(fs.writeFileAtomic(unreadable, 'y')).resolves.toEqual({
        ok: false,
        error: 'access-denied'
      })
      await expect(fs.writeFileAtomic(vanished, 'y')).resolves.toEqual({
        ok: false,
        error: 'not-found'
      })
      await expect(fs.readFile(busy)).resolves.toEqual({ ok: false, error: 'busy' })
      // Only the chosen paths fail.
      await expect(fs.writeFileAtomic(free, 'y')).resolves.toEqual({ ok: true, value: undefined })
    })
  })
}
