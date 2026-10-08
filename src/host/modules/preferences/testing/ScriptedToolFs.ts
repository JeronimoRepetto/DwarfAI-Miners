// A FileSystem around FakeFs or NodeFs that plays the other tool and the OS around one config
// file (16 §7.6; 17 §1.10 CH-07, CH-11): the tool editing the file between two reads, the file
// locked by the tool, a sharing violation that clears, and the Host dying before or after a write
// lands. Every operation it does not script goes to the wrapped FileSystem unchanged, so the
// same contract runs over memory and over a real temporary directory. Never imported by
// production code (R14).
import type { Result } from '../../../kernel/domain/values'
import type {
  DirEntry,
  FileStat,
  FileSystem,
  FsError,
  SizedDirEntry
} from '../../../kernel/ports/fileSystem'

/** What the Host dying looks like to the code under test: the call never returns normally. */
export class SimulatedCrash extends Error {
  constructor() {
    super('simulated Host crash')
  }
}

type Edit = (current: string) => string

const decoder = new TextDecoder()

export class ScriptedToolFs implements FileSystem {
  private readonly reads = new Map<string, number>()
  private readonly edits = new Map<string, Map<number, Edit>>()
  private readonly locks = new Set<string>()
  private readonly transientFaults = new Map<string, { error: FsError; left: number }>()
  private readonly crashes = new Map<string, 'before-write' | 'after-write'>()
  /** Every data write that reached the wrapped FileSystem, by path, in order. */
  readonly writes: string[] = []

  constructor(private readonly inner: FileSystem) {}

  /** Before the n-th `readFile` of `path` (1-based, counted from now) the tool rewrites the file. */
  toolEditsBeforeRead(path: string, ordinals: readonly number[], edit: Edit): void {
    this.reads.set(path, 0)
    this.edits.set(path, new Map(ordinals.map((n) => [n, edit])))
  }

  /** The tool holds `path` open: every write or delete of it fails `busy` until released. */
  lock(path: string, locked = true): void {
    if (locked) this.locks.add(path)
    else this.locks.delete(path)
  }

  /** The next `times` writes of `path` fail with `error` (a sharing violation that clears). */
  failWrites(path: string, error: FsError, times: number): void {
    this.transientFaults.set(path, { error, left: times })
  }

  /** The Host dies at the next data write of `path`: before it lands, or right after. */
  crashAt(path: string, when: 'before-write' | 'after-write'): void {
    this.crashes.set(path, when)
  }

  async readFile(path: string): Promise<Result<Uint8Array, FsError>> {
    const count = (this.reads.get(path) ?? 0) + 1
    this.reads.set(path, count)
    const edit = this.edits.get(path)?.get(count)
    if (edit !== undefined) {
      const current = await this.inner.readFile(path)
      const text = current.ok ? decoder.decode(current.value) : ''
      await this.inner.writeFileAtomic(path, edit(text))
    }
    return this.inner.readFile(path)
  }

  async writeFileAtomic(path: string, data: Uint8Array | string): Promise<Result<void, FsError>> {
    return this.dataWrite(path, () => this.inner.writeFileAtomic(path, data))
  }

  async appendFile(path: string, data: Uint8Array | string): Promise<Result<void, FsError>> {
    return this.dataWrite(path, () => this.inner.appendFile(path, data))
  }

  async deleteFile(path: string): Promise<Result<void, FsError>> {
    const refused = this.refusal(path)
    if (refused !== null) return refused
    return this.inner.deleteFile(path)
  }

  readTextTail(path: string, maxBytes: number): Promise<string> {
    return this.inner.readTextTail(path, maxBytes)
  }

  readTextHead(path: string, maxBytes: number): Promise<string> {
    return this.inner.readTextHead(path, maxBytes)
  }

  readJson(path: string): Promise<unknown> {
    return this.inner.readJson(path)
  }

  listDir(path: string): Promise<DirEntry[]> {
    return this.inner.listDir(path)
  }

  stat(path: string): Promise<FileStat | null> {
    return this.inner.stat(path)
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path)
  }

  listDirWithSizes(path: string): Promise<Result<SizedDirEntry[], FsError>> {
    return this.inner.listDirWithSizes(path)
  }

  makeDir(path: string): Promise<Result<void, FsError>> {
    return this.inner.makeDir(path)
  }

  private async dataWrite(
    path: string,
    write: () => Promise<Result<void, FsError>>
  ): Promise<Result<void, FsError>> {
    const crash = this.crashes.get(path)
    if (crash !== undefined) this.crashes.delete(path)
    if (crash === 'before-write') throw new SimulatedCrash()
    const refused = this.refusal(path)
    if (refused !== null) return refused
    const written = await write()
    if (written.ok) this.writes.push(path)
    if (crash === 'after-write') throw new SimulatedCrash()
    return written
  }

  private refusal(path: string): Result<void, FsError> | null {
    if (this.locks.has(path)) return { ok: false, error: 'busy' }
    const fault = this.transientFaults.get(path)
    if (fault === undefined || fault.left === 0) return null
    fault.left -= 1
    return { ok: false, error: fault.error }
  }
}
