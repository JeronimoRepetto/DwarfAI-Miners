// The FileSystem double (16 §2.8): today's FakeFs (adapters/fakeFs.ts), transplanted with its name
// and behaviour, extended with the typed half of the port and with write faults scripted per path
// for the chaos injectors CH-06 (`ENOSPC`) and CH-07 (`EBUSY`, `EPERM`, `EACCES`) of 17 §1.10.
// It runs the same runFileSystemContract as NodeFs. Never imported by production code (R14).
import { parseJsonText } from '../../../contracts/text'
import type { Result } from '../domain/values'
import type { DirEntry, FileStat, FileSystem, FsError, SizedDirEntry } from '../ports/fileSystem'
import type { ScriptedFsFault } from '../testing/fileSystem.contract'

interface FakeFile {
  content: Uint8Array
  mtimeMs: number
  /** Spare capacity behind `content` so a long run of appends stays linear (a 5 MB segment). */
  storage?: Uint8Array
}

/** What NodeFs maps each scripted OS code to (its `fsErrorOf`). */
const FAULT_ERRORS: Readonly<Record<ScriptedFsFault, FsError>> = {
  ENOENT: 'not-found',
  ENOSPC: 'no-space',
  EBUSY: 'busy',
  EPERM: 'access-denied',
  EACCES: 'access-denied'
}

/**
 * The single normalization point for every path this fake sees, on the way in
 * (addFile) and on the way out (every read).
 *
 * Both separators collapse to one, so a fixture registered with POSIX paths is
 * found by a provider that built its path with node:path.join on Windows and
 * vice versa. That is deliberate: it is what lets one set of fixtures prove
 * path portability without being rewritten for each host, and what keeps the
 * fake's own key format from leaking into any test's expectations.
 */
function normalize(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '')
}

function parentOf(normalized: string): string {
  const separatorAt = normalized.lastIndexOf('\\')
  return separatorAt === -1 ? '' : normalized.slice(0, separatorAt)
}

/**
 * In-memory FileSystem used by unit tests. Files are registered with addFile();
 * directories exist implicitly for every ancestor of a registered file, and
 * explicitly once made with makeDir() (so an empty directory can exist).
 * Paths accept / or \ separators and are matched case-sensitively.
 */
export class FakeFs implements FileSystem {
  private readonly files = new Map<string, FakeFile>()
  private readonly faults = new Map<string, ScriptedFsFault>()
  private readonly dirs = new Set<string>()

  /**
   * Awaited before every read. Tests set it to suspend a scan mid-flight and
   * observe what a concurrent caller (a click arriving during a poll tick)
   * sees while the provider is still rebuilding its internal state.
   */
  onBeforeRead?: (path: string) => Promise<void>

  addFile(path: string, content: string, mtimeMs = 0): void {
    this.files.set(normalize(path), { content: Buffer.from(content, 'utf8'), mtimeMs })
  }

  removeFile(path: string): void {
    this.files.delete(normalize(path))
  }

  /** Every later operation on `path` fails as the OS would report `fault` (CH-06, CH-07). */
  scriptFault(path: string, fault: ScriptedFsFault): void {
    this.faults.set(normalize(path), fault)
  }

  /** The disk is writable again at `path` (the fault scripted on it is lifted). */
  clearFault(path: string): void {
    this.faults.delete(normalize(path))
  }

  /** Deletes a directory with everything under it, as a person emptying the folder would (FM-108). */
  removeDir(path: string): void {
    const key = normalize(path)
    const prefix = key + '\\'
    for (const file of [...this.files.keys()]) if (file.startsWith(prefix)) this.files.delete(file)
    for (const dir of [...this.dirs])
      if (dir === key || dir.startsWith(prefix)) this.dirs.delete(dir)
  }

  /**
   * Synchronous view of a directory's direct children, for a double whose port is synchronous
   * (`FakeLogDirectory`); `null` when the directory does not exist or is faulted.
   */
  entriesNow(path: string): SizedDirEntry[] | null {
    if (this.faults.has(normalize(path)) || !this.isDir(path)) return null
    return this.entriesOf(path)
  }

  /** Synchronous read of up to `maxBytes` from the start of a file; `null` when unreadable. */
  headNow(path: string, maxBytes: number): string | null {
    const key = normalize(path)
    const file = this.faults.has(key) ? undefined : this.files.get(key)
    if (!file) return null
    return Buffer.from(file.content.subarray(0, maxBytes)).toString('utf8')
  }

  private isDir(path: string): boolean {
    const key = normalize(path)
    if (this.dirs.has(key)) return true
    const prefix = key + '\\'
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) return true
    }
    for (const dir of this.dirs) {
      if (dir.startsWith(prefix)) return true
    }
    return false
  }

  /** The file, or a rejection like the one NodeFs's read half gives for an unreadable path. */
  private fileOrThrow(path: string): FakeFile {
    const key = normalize(path)
    const file = this.faults.has(key) ? undefined : this.files.get(key)
    if (!file) throw new Error(`FakeFs: no such file ${path}`)
    return file
  }

  async readTextTail(path: string, maxBytes: number): Promise<string> {
    await this.onBeforeRead?.(path)
    const bytes = Buffer.from(this.fileOrThrow(path).content)
    return bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString('utf8')
  }

  async readTextHead(path: string, maxBytes: number): Promise<string> {
    await this.onBeforeRead?.(path)
    const bytes = Buffer.from(this.fileOrThrow(path).content)
    return bytes.subarray(0, maxBytes).toString('utf8')
  }

  async readJson(path: string): Promise<unknown> {
    await this.onBeforeRead?.(path)
    // In step with NodeFs (#555): both tolerate the BOM a Windows editor
    // writes, because a fake that parsed differently from the real adapter
    // would make every test that reads through it prove the wrong thing.
    return parseJsonText(Buffer.from(this.fileOrThrow(path).content).toString('utf8'))
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const listed = this.entriesOf(path)
    return listed.map(({ name, isDirectory }) => ({ name, isDirectory }))
  }

  async stat(path: string): Promise<FileStat | null> {
    const key = normalize(path)
    if (this.faults.has(key)) return null
    const file = this.files.get(key)
    if (file) {
      return { mtimeMs: file.mtimeMs, size: file.content.byteLength, isDirectory: false }
    }
    if (this.isDir(path)) {
      return { mtimeMs: 0, size: 0, isDirectory: true }
    }
    return null
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null
  }

  async readFile(path: string): Promise<Result<Uint8Array, FsError>> {
    await this.onBeforeRead?.(path)
    const key = normalize(path)
    const fault = this.faults.get(key)
    if (fault) return { ok: false, error: FAULT_ERRORS[fault] }
    const file = this.files.get(key)
    if (file) return { ok: true, value: new Uint8Array(file.content) }
    // Reading a directory as a file is an OS failure other than not-found (EISDIR).
    return { ok: false, error: this.isDir(path) ? 'io' : 'not-found' }
  }

  async listDirWithSizes(path: string): Promise<Result<SizedDirEntry[], FsError>> {
    await this.onBeforeRead?.(path)
    const fault = this.faults.get(normalize(path))
    if (fault) return { ok: false, error: FAULT_ERRORS[fault] }
    if (!this.isDir(path)) return { ok: false, error: 'not-found' }
    return { ok: true, value: this.entriesOf(path) }
  }

  async writeFileAtomic(path: string, data: Uint8Array | string): Promise<Result<void, FsError>> {
    const key = normalize(path)
    const fault = this.faults.get(key)
    // A fault leaves the old bytes in place, as the temp-and-rename write does on disk.
    if (fault) return { ok: false, error: FAULT_ERRORS[fault] }
    const parent = parentOf(key)
    if (parent !== '' && !this.isDir(parent)) return { ok: false, error: 'not-found' }
    // A rename cannot replace a directory with a file (EISDIR / EPERM on disk).
    if (this.isDir(path)) return { ok: false, error: 'io' }
    const content = typeof data === 'string' ? Buffer.from(data, 'utf8') : new Uint8Array(data)
    this.files.set(key, { content, mtimeMs: this.files.get(key)?.mtimeMs ?? 0 })
    return { ok: true, value: undefined }
  }

  async appendFile(path: string, data: Uint8Array | string): Promise<Result<void, FsError>> {
    const key = normalize(path)
    const fault = this.faults.get(key)
    // A fault leaves the file as it was: nothing of the failed append lands.
    if (fault) return { ok: false, error: FAULT_ERRORS[fault] }
    const parent = parentOf(key)
    if (parent !== '' && !this.isDir(parent)) return { ok: false, error: 'not-found' }
    if (this.isDir(path)) return { ok: false, error: 'io' }
    const added = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    const file = this.files.get(key) ?? { content: new Uint8Array(0), mtimeMs: 0 }
    const length = file.content.byteLength + added.byteLength
    let storage = file.storage
    if (storage === undefined || storage.byteLength < length) {
      storage = new Uint8Array(Math.max(1024, length * 2))
      storage.set(file.content)
    }
    storage.set(added, file.content.byteLength)
    this.files.set(key, { content: storage.subarray(0, length), mtimeMs: file.mtimeMs, storage })
    return { ok: true, value: undefined }
  }

  async deleteFile(path: string): Promise<Result<void, FsError>> {
    const key = normalize(path)
    const fault = this.faults.get(key)
    if (fault) return { ok: false, error: FAULT_ERRORS[fault] }
    if (!this.files.has(key)) return { ok: false, error: this.isDir(path) ? 'io' : 'not-found' }
    this.files.delete(key)
    return { ok: true, value: undefined }
  }

  async makeDir(path: string): Promise<Result<void, FsError>> {
    const key = normalize(path)
    const fault = this.faults.get(key)
    if (fault) return { ok: false, error: FAULT_ERRORS[fault] }
    // A file in the way of the directory or of one of its parents fails as on disk (EEXIST / ENOTDIR).
    for (let at: string = key; at !== ''; at = parentOf(at)) {
      if (this.files.has(at)) return { ok: false, error: at === key ? 'io' : 'not-found' }
    }
    this.dirs.add(key)
    return { ok: true, value: undefined }
  }

  /** The direct children of a directory, with each file's byte size (a directory's is 0). */
  private entriesOf(path: string): SizedDirEntry[] {
    const prefix = normalize(path) + '\\'
    const entries = new Map<string, SizedDirEntry>()
    for (const [key, file] of this.files) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const separatorAt = rest.indexOf('\\')
      if (separatorAt === -1) {
        entries.set(rest, { name: rest, isDirectory: false, size: file.content.byteLength })
      } else {
        const name = rest.slice(0, separatorAt)
        entries.set(name, { name, isDirectory: true, size: 0 })
      }
    }
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix)) continue
      const name = dir.slice(prefix.length).split('\\')[0] ?? ''
      if (name !== '' && !entries.has(name)) entries.set(name, { name, isDirectory: true, size: 0 })
    }
    return [...entries.values()]
  }
}
