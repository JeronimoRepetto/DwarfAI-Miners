// The Host's SegmentWriter (05 §3.13, 16 §4.13; ADR-026 items 1–2; 19 §2, §4): appends log lines to
// `<prefix><seq>.jsonl` segments of the shared `logs/` folder, closes a segment at 5 000 000 bytes,
// runs the pure `planPrune` before opening a segment and after every 256 KiB written, and recreates
// the folder when it was deleted (13 FM-108). It never throws for an OS failure: that is a typed
// result the caller counts.
import { join } from 'node:path'
import {
  LOG_CAP_BYTES,
  LOG_SEGMENT_BYTES,
  PRUNE_EVERY_BYTES,
  nextSeq,
  planPrune,
  segmentName,
  type SegmentPrefix
} from '../../../../contracts/logging'
import type { Result } from '../../../kernel/domain/values'
import type { FileSystem, FsError } from '../../../kernel/ports/fileSystem'
import type { LogDirectory } from '../ports/logDirectory'

export interface SegmentWriterDeps {
  readonly fs: FileSystem
  readonly directory: LogDirectory
  /** The shared `logs/` folder (ADR-026 item 1). */
  readonly dir: string
  readonly prefix: SegmentPrefix
  /** Told after each prune run that deleted something (19 §9.6 `log.pruned`). */
  readonly onPruned?: (pruned: { count: number; bytes: number }) => void
}

interface OpenSegment {
  readonly name: string
  bytes: number
}

const OK: Result<void, FsError> = { ok: true, value: undefined }

export class FsSegmentWriter {
  private current: OpenSegment | null = null
  private lastSeq = 0
  private sincePrune = 0

  constructor(private readonly deps: SegmentWriterDeps) {}

  /**
   * Appends one line (already ending in `\n`). A line that would take the open segment past
   * 5 000 000 bytes goes to a new segment. When the folder or the segment vanished (another
   * writer's prune, a person deleting the folder), the next segment is opened and the line
   * written there once more (FM-108).
   */
  async append(line: string): Promise<Result<void, FsError>> {
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (
      this.current !== null &&
      this.current.bytes > 0 &&
      this.current.bytes + lineBytes > LOG_SEGMENT_BYTES
    ) {
      this.current = null
    }
    let written = await this.appendToOpen(line)
    if (!written.ok && written.error === 'not-found') {
      this.current = null
      written = await this.appendToOpen(line)
    }
    if (!written.ok) return written
    const segment = this.current as OpenSegment | null
    if (segment !== null) segment.bytes += lineBytes
    this.sincePrune += lineBytes
    if (this.sincePrune >= PRUNE_EVERY_BYTES) await this.prune()
    return OK
  }

  /** Closes the open segment; the next append opens a new one. */
  async close(): Promise<void> {
    this.current = null
  }

  private async appendToOpen(line: string): Promise<Result<void, FsError>> {
    if (this.current === null) {
      const opened = await this.open()
      if (!opened.ok) return opened
    }
    const segment = this.current as OpenSegment | null
    if (segment === null) return { ok: false, error: 'io' }
    return this.deps.fs.appendFile(join(this.deps.dir, segment.name), line)
  }

  /** Recreates the folder if needed, prunes, then names the next segment of this prefix. */
  private async open(): Promise<Result<void, FsError>> {
    const made = await this.deps.fs.makeDir(this.deps.dir)
    if (!made.ok) return made
    await this.prune()
    const names = this.deps.directory.segments().map((segment) => segment.name)
    // Continue after the highest seq on disk, and never reuse one of ours after a folder loss.
    const seq = Math.max(nextSeq(names, this.deps.prefix), this.lastSeq + 1)
    this.lastSeq = seq
    this.current = { name: segmentName(this.deps.prefix, seq), bytes: 0 }
    return OK
  }

  /** ADR-026 item 2: delete the oldest segments until total + one segment ≤ the cap. */
  private async prune(): Promise<void> {
    this.sincePrune = 0
    const segments = this.deps.directory.segments()
    const sizes = new Map(segments.map((segment) => [segment.name, segment.bytes]))
    let count = 0
    let bytes = 0
    for (const name of planPrune(segments, LOG_CAP_BYTES, LOG_SEGMENT_BYTES)) {
      const deleted = await this.deps.fs.deleteFile(join(this.deps.dir, name))
      // Another writer deleting the same segment first is a benign race (ENOENT ignored).
      if (!deleted.ok) continue
      count += 1
      bytes += sizes.get(name) ?? 0
      if (this.current?.name === name) this.current.bytes = 0
    }
    if (count > 0) this.deps.onPruned?.({ count, bytes })
  }
}
