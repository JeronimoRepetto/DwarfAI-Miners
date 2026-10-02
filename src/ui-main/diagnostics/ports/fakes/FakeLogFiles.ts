// The LogFiles double (16 §2.8): an in-memory folder tree that runs the same runLogFilesContract as
// NodeLogFiles. A file keeps its byte size, its first bytes (for the first-record `ts`) and, unless it was
// seeded with a size only, its whole text. It records the peak total size of each folder after every change
// and the order of deletions, and can fail the next appends. Never imported by production code (R14).
// Each folder keeps a running byte total, so the peak check after an append is O(1), not a scan of the folder:
// the cap tests push tens of thousands of lines through a folder of twenty segments.
import { dirname, join } from 'node:path'
import { parseSegmentName, type SegmentInfo } from '@dwarfai/contracts'
import type { AppendOutcome, LogFiles } from '../logFiles'

const FIRST_TS = /^\{"ts":"([^"\\\r\n]{1,64})"/
const HEAD_CHARS = 128

interface FakeFile {
  bytes: number
  head: string
  /** The appended text; `null` for a file seeded by size only. */
  text: string | null
}

export class FakeLogFiles implements LogFiles {
  private readonly dirs = new Set<string>()
  private readonly files = new Map<string, FakeFile>()
  private readonly peaks = new Map<string, number>()
  /** The sum of the byte sizes of the files directly in each folder. */
  private readonly dirBytes = new Map<string, number>()
  private failures: Array<AppendOutcome | 'throw'> = []
  /** Every deleted path, in deletion order. */
  readonly deleted: string[] = []

  async makeDir(dir: string): Promise<boolean> {
    for (let d = dir; !this.dirs.has(d); d = dirname(d)) {
      this.dirs.add(d)
      if (dirname(d) === d) break
    }
    return true
  }

  async append(path: string, data: string): Promise<AppendOutcome> {
    const failure = this.failures.shift()
    if (failure === 'throw') throw new Error('fake append failure')
    if (failure !== undefined) return failure
    if (!this.dirs.has(dirname(path))) return 'not-found'
    const file = this.files.get(path) ?? { bytes: 0, head: '', text: '' }
    const bytes = Buffer.byteLength(data, 'utf8')
    file.bytes += bytes
    this.addBytes(dirname(path), bytes)
    if (file.head.length < HEAD_CHARS) file.head = (file.head + data).slice(0, HEAD_CHARS)
    if (file.text !== null) file.text += data
    this.files.set(path, file)
    this.notePeak(dirname(path))
    return 'ok'
  }

  async remove(path: string): Promise<boolean> {
    const file = this.files.get(path)
    if (file === undefined) return false
    this.files.delete(path)
    this.addBytes(dirname(path), -file.bytes)
    this.deleted.push(path)
    return true
  }

  async segments(dir: string): Promise<SegmentInfo[]> {
    return this.namesIn(dir)
      .filter((name) => parseSegmentName(name) !== null)
      .map((name) => {
        const file = this.files.get(join(dir, name)) as FakeFile
        return { name, bytes: file.bytes, firstTs: FIRST_TS.exec(file.head)?.[1] ?? '' }
      })
  }

  // ---- test controls

  /** A file of `bytes` bytes whose first record has `firstTs` (written by another process, size only). */
  seed(path: string, bytes: number, firstTs: string): void {
    this.dirs.add(dirname(path))
    this.put(path, { bytes, head: `{"ts":"${firstTs}"`, text: null })
    this.notePeak(dirname(path))
  }

  /** Any file, as another program would leave it. */
  plant(path: string, text: string): void {
    this.put(path, { bytes: Buffer.byteLength(text, 'utf8'), head: text, text })
  }

  /** The next appends end with these outcomes (or throw), one each, before appends work again. */
  failNextAppends(...outcomes: Array<AppendOutcome | 'throw'>): void {
    this.failures.push(...outcomes)
  }

  /** Forgets `dir` and everything in it, as a person deleting the folder. */
  removeDir(dir: string): void {
    for (const path of [...this.files.keys()]) if (dirname(path) === dir) this.files.delete(path)
    this.dirBytes.delete(dir)
    this.dirs.delete(dir)
  }

  names(dir: string): string[] {
    return this.namesIn(dir).sort()
  }

  sizeOf(path: string): number | undefined {
    return this.files.get(path)?.bytes
  }

  textOf(path: string): string | undefined {
    return this.files.get(path)?.text ?? undefined
  }

  totalBytes(dir: string): number {
    return this.dirs.has(dir) ? (this.dirBytes.get(dir) ?? 0) : 0
  }

  /** The largest total size `dir` reached after any append or seed. */
  peakBytes(dir: string): number {
    return this.peaks.get(dir) ?? 0
  }

  private namesIn(dir: string): string[] {
    if (!this.dirs.has(dir)) return []
    return [...this.files.keys()]
      .filter((path) => dirname(path) === dir)
      .map((path) => path.slice(dir.length + 1))
  }

  /** Sets the file at `path`, replacing any earlier one and its bytes. */
  private put(path: string, file: FakeFile): void {
    const dir = dirname(path)
    this.addBytes(dir, file.bytes - (this.files.get(path)?.bytes ?? 0))
    this.files.set(path, file)
  }

  private addBytes(dir: string, bytes: number): void {
    this.dirBytes.set(dir, (this.dirBytes.get(dir) ?? 0) + bytes)
  }

  private notePeak(dir: string): void {
    this.peaks.set(dir, Math.max(this.peaks.get(dir) ?? 0, this.totalBytes(dir)))
  }
}
