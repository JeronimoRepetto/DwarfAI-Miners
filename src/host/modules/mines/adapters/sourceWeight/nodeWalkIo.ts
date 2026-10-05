// The source-weight walk's io over node:fs (`SourceWalkIo`), used inside the scan worker. A folder
// that cannot be listed answers its reason (`not-found`, `access-denied`, `busy`, `io`); a file
// that cannot be read has no size, and keeps a fingerprint of its own so it is never taken for a
// copy. Read-only: nothing here writes.
//
// Loaded by the worker entry with an explicit `.ts` specifier and written in erasable syntax only:
// under vitest Node itself runs the worker's TypeScript (type stripping), see `scanWorker.ts`.
import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SourceWalkIo } from './sourceWalk.ts'

function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-found'
  if (code === 'EACCES' || code === 'EPERM') return 'access-denied'
  if (code === 'EBUSY') return 'busy'
  return 'io'
}

export const nodeWalkIo: SourceWalkIo = {
  list: async (dir) => {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      return {
        ok: true,
        value: entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
      }
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    }
  },
  size: async (file) => {
    try {
      return (await stat(file)).size
    } catch {
      return null
    }
  },
  fingerprint: async (file, size, sampleBytes) => {
    const hash = createHash('sha1')
    try {
      const handle = await open(file, 'r')
      try {
        const sample = new Uint8Array(Math.min(size, sampleBytes))
        const { bytesRead } = await handle.read(sample, 0, sample.byteLength, 0)
        hash.update(sample.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
    } catch {
      hash.update(file)
    }
    return `${size}:${hash.digest('hex')}`
  },
  // The walked folder is on this machine, so the running host's separator is the folder's own.
  join: (dir, name) => join(dir, name)
}
