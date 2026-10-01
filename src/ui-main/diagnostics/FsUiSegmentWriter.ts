// The UI's SegmentWriter (05 §3.13 "UI: its own FsSegmentWriter in src/ui-main/diagnostics"; ADR-026 items 1–2;
// 19 §2, §4): appends log lines to `ui-<seq>.jsonl` segments of the shared `logs/` folder, closes a segment at
// 5 000 000 bytes, and runs the pure `planPrune` over every prefix (`host-`, `ui-`, `shim-`) before opening a
// segment and after every 256 KiB written, so the folder holds at most 100 000 000 bytes with the Host's and the
// shims' segments in it. It recreates the folder when it was deleted (13 FM-108) and never throws for an OS
// failure: the caller gets `false` and counts the record.
import { join } from 'node:path'
import {
  LOG_CAP_BYTES,
  LOG_SEGMENT_BYTES,
  PRUNE_EVERY_BYTES,
  nextSeq,
  planPrune,
  segmentName
} from '@dwarfai/contracts'
import type { LogFiles } from './ports/logFiles'

export interface UiSegmentWriterDeps {
  readonly files: LogFiles
  /** The shared `logs/` folder (ADR-026 item 1). */
  readonly dir: string
  /** Told after each prune run that deleted something (19 §9.6 `log.pruned`). */
  readonly onPruned?: (pruned: { count: number; bytes: number }) => void
}

const PREFIX = 'ui-'

interface OpenSegment {
  readonly name: string
  bytes: number
}

export class FsUiSegmentWriter {
  private current: OpenSegment | null = null
  private lastSeq = 0
  private sincePrune = 0

  constructor(private readonly deps: UiSegmentWriterDeps) {}

  /**
   * Appends one line (already ending in `\n`); `true` when it was written. A line that would take the open segment
   * past 5 000 000 bytes goes to a new segment. When the folder or the segment vanished, the next segment is
   * opened and the line written there once more (FM-108).
   */
  async append(line: string): Promise<boolean> {
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (
      this.current !== null &&
      this.current.bytes > 0 &&
      this.current.bytes + lineBytes > LOG_SEGMENT_BYTES
    ) {
      this.current = null
    }
    let outcome = await this.appendToOpen(line)
    if (outcome === 'not-found') {
      this.current = null
      outcome = await this.appendToOpen(line)
    }
    if (outcome !== 'ok') return false
    const segment = this.current as OpenSegment | null
    if (segment !== null) segment.bytes += lineBytes
    this.sincePrune += lineBytes
    if (this.sincePrune >= PRUNE_EVERY_BYTES) await this.prune()
    return true
  }

  private async appendToOpen(line: string): Promise<'ok' | 'not-found' | 'failed'> {
    if (this.current === null && !(await this.open())) return 'failed'
    const segment = this.current as OpenSegment | null
    if (segment === null) return 'failed'
    return this.deps.files.append(join(this.deps.dir, segment.name), line)
  }

  /** Recreates the folder if needed, prunes, then names the next `ui-` segment. */
  private async open(): Promise<boolean> {
    if (!(await this.deps.files.makeDir(this.deps.dir))) return false
    const names = (await this.prune()).map((segment) => segment.name)
    // Continue after the highest seq listed, and never reuse one of ours after a folder loss.
    const seq = Math.max(nextSeq(names, PREFIX), this.lastSeq + 1)
    this.lastSeq = seq
    this.current = { name: segmentName(PREFIX, seq), bytes: 0 }
    return true
  }

  /**
   * ADR-026 item 2: deletes the oldest segments of every prefix until total + one segment ≤ the cap. Answers the
   * listing it pruned from, deleted segments included, so a new seq is never one this folder already used.
   */
  private async prune(): Promise<{ name: string }[]> {
    this.sincePrune = 0
    const segments = await this.deps.files.segments(this.deps.dir)
    const sizes = new Map(segments.map((segment) => [segment.name, segment.bytes]))
    let count = 0
    let bytes = 0
    for (const name of planPrune(segments, LOG_CAP_BYTES, LOG_SEGMENT_BYTES)) {
      // Another writer deleting the same segment first is a benign race (ENOENT ignored).
      if (!(await this.deps.files.remove(join(this.deps.dir, name)))) continue
      count += 1
      bytes += sizes.get(name) ?? 0
      if (this.current?.name === name) this.current.bytes = 0
    }
    if (count > 0) this.deps.onPruned?.({ count, bytes })
    return segments
  }
}
