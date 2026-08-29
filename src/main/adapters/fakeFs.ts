import type { DirEntry, FileStat, FsLike } from './fsLike'

interface FakeFile {
  content: string
  mtimeMs: number
}

function normalize(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '')
}

/**
 * In-memory FsLike used by unit tests. Files are registered with addFile();
 * directories exist implicitly for every ancestor of a registered file.
 * Paths accept / or \ separators and are matched case-sensitively.
 */
export class FakeFs implements FsLike {
  private readonly files = new Map<string, FakeFile>()

  addFile(path: string, content: string, mtimeMs = 0): void {
    this.files.set(normalize(path), { content, mtimeMs })
  }

  removeFile(path: string): void {
    this.files.delete(normalize(path))
  }

  private byteLength(content: string): number {
    return Buffer.byteLength(content, 'utf8')
  }

  private isDir(path: string): boolean {
    const prefix = normalize(path) + '\\'
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }

  async readTextTail(path: string, maxBytes: number): Promise<string> {
    const file = this.files.get(normalize(path))
    if (!file) throw new Error(`FakeFs: no such file ${path}`)
    const bytes = Buffer.from(file.content, 'utf8')
    return bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString('utf8')
  }

  async readTextHead(path: string, maxBytes: number): Promise<string> {
    const file = this.files.get(normalize(path))
    if (!file) throw new Error(`FakeFs: no such file ${path}`)
    const bytes = Buffer.from(file.content, 'utf8')
    return bytes.subarray(0, maxBytes).toString('utf8')
  }

  async readJson(path: string): Promise<unknown> {
    const file = this.files.get(normalize(path))
    if (!file) throw new Error(`FakeFs: no such file ${path}`)
    return JSON.parse(file.content)
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const prefix = normalize(path) + '\\'
    const names = new Map<string, boolean>()
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const separatorAt = rest.indexOf('\\')
      if (separatorAt === -1) {
        names.set(rest, false)
      } else {
        names.set(rest.slice(0, separatorAt), true)
      }
    }
    return [...names.entries()].map(([name, isDirectory]) => ({ name, isDirectory }))
  }

  async stat(path: string): Promise<FileStat | null> {
    const file = this.files.get(normalize(path))
    if (file) {
      return { mtimeMs: file.mtimeMs, size: this.byteLength(file.content), isDirectory: false }
    }
    if (this.isDir(path)) {
      return { mtimeMs: 0, size: 0, isDirectory: true }
    }
    return null
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null
  }
}
