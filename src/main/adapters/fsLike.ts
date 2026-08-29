import { open, readFile, readdir, stat as fsStat } from 'node:fs/promises'

/** One entry of a directory listing. */
export interface DirEntry {
  name: string
  isDirectory: boolean
}

/** Subset of stat information the app needs. */
export interface FileStat {
  mtimeMs: number
  size: number
  isDirectory: boolean
}

/**
 * Tiny filesystem port. Everything that touches the disk goes through this
 * interface so providers and services stay unit-testable with an in-memory fake.
 *
 * Error contract: readTextTail/readTextHead/readJson reject when the file is
 * missing; listDir resolves to [] for a missing directory; stat resolves to
 * null for a missing path.
 */
export interface FsLike {
  /** Read up to `maxBytes` from the END of a UTF-8 text file. */
  readTextTail(path: string, maxBytes: number): Promise<string>
  /** Read up to `maxBytes` from the START of a UTF-8 text file. */
  readTextHead(path: string, maxBytes: number): Promise<string>
  readJson(path: string): Promise<unknown>
  listDir(path: string): Promise<DirEntry[]>
  stat(path: string): Promise<FileStat | null>
  exists(path: string): Promise<boolean>
}

/** Real Node implementation used by the running app. */
export class NodeFs implements FsLike {
  async readTextTail(path: string, maxBytes: number): Promise<string> {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, maxBytes)
      const position = size - length
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, position)
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  }

  async readTextHead(path: string, maxBytes: number): Promise<string> {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, maxBytes)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  }

  async readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, 'utf8'))
  }

  async listDir(path: string): Promise<DirEntry[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    } catch {
      return []
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const info = await fsStat(path)
      return { mtimeMs: info.mtimeMs, size: info.size, isDirectory: info.isDirectory() }
    } catch {
      return null
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null
  }
}
