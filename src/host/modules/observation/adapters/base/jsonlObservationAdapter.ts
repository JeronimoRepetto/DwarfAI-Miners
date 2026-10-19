// The shared observation adapter base for line-oriented provider files (15 §5; 05 §3.3 "shared ←
// providers/feedWindow.ts, firstPrompt.ts, provider.ts"): a provider adapter gives its roots, the
// file names it reads and a pure line parser; the base does the rest, for every provider alike.
//
// - `discover` walks the roots, identifies each file (`fileIdentity.ts`): one stream per file
//   identity whatever path reached it, and only the files whose longest root prefix is this
//   adapter's (FM-093). The stream id is a hash of the canonical path: stable across cycles and
//   Host runs, and no path is stored in it (ADR-026 item 4).
// - `read` is a bounded tail read from the byte-offset cursor (FM-088): the unread tail only, never
//   more than `OBSERVATION_TAIL_GATE_BYTES`. A line the parser cannot read is skipped with a
//   warning (INV-38, FM-086). A last line with no newline is left for a later read while the file
//   changes, and parsed once the file stopped changing for `OBSERVATION_SETTLE_MS` (FM-089): the
//   loop's poll is what sees it, no file-system event is needed. A read during which the file
//   changed size is dropped and re-read at the next poll.
// - `entries` (`TranscriptReader`, 16 §4.3) is a window read of the newest part of a stream,
//   widened through the feed-window steps until the page is complete (#215, #188); [] for an
//   unknown or unreadable stream, never a throw.
//
// No provider is named here (R12): the parser and the roots are the provider adapter's.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ProviderId } from '../../../../kernel/domain/values'
import type { Clock } from '../../../../kernel/ports/clock'
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
import type { ObservedCapabilities } from '../../../suppliers'
import type {
  Cursor,
  ObservationAdapter,
  ObservedEvent,
  SourceFile
} from '../../ports/observationAdapter'
import type { ObservedSessionRef } from '../../ports/observedSessionStore'
import type { TranscriptEntry, TranscriptReader } from '../../ports/transcriptReader'
import { FEED_WINDOW_STEPS, needsWiderWindow, pageBefore } from './feedWindow'
import { canonicalRoot, nodeFileIdentity, type FileIdentifier } from './fileIdentity'
import { dispatchedTo } from './sourceDispatch'
import { splitTail } from './tailRead'

/** The most a single read takes of a stream's unread tail (FM-088; today's 8 MiB feed ceiling). */
export const OBSERVATION_TAIL_GATE_BYTES = 8 * 1024 * 1024

/** How long a file must stop changing before its unterminated last line is parsed (FM-089). */
export const OBSERVATION_SETTLE_MS = 1_000

/** How deep `discover` walks below a root. */
const MAX_DEPTH = 6

/** One line handed to the provider's parser. */
export interface JsonlLine {
  text: string
  /** Byte offset of the line in its file: a deterministic event id where a record has none. */
  offset: number
  streamId: string
  adapterId: string
}

export interface JsonlObservationAdapterOptions {
  providerId: ProviderId
  /** Declared as data (HO-14); an omitted field fails closed (ADR-009 D3). */
  capabilities: ObservedCapabilities
  /** The provider's data folders (15 §5 "Sources"). */
  roots: readonly string[]
  /** The other adapters' roots, for the longest-prefix dispatch (FM-093). */
  claimedRoots: readonly string[]
  /** Which file names under the roots are this provider's streams. */
  matches(name: string): boolean
  /** Pure: a line's events, or null for a line it cannot read (skipped with a warning). */
  parse(line: JsonlLine): ObservedEvent[] | null
  /** Where reads happen (the kernel `FileSystem`). */
  fs: FileSystem
  clock: Clock
  identify?: FileIdentifier
}

interface Unsettled {
  size: number
  since: number
}

export class JsonlObservationAdapter implements ObservationAdapter, TranscriptReader {
  readonly providerId: ProviderId
  readonly cursorKind = 'byte-offset' as const
  private readonly identify: FileIdentifier
  /** The path of each stream the last `discover` found, for reads and window reads. */
  private readonly paths = new Map<string, string>()
  /** A stream whose last line has no newline yet: its size and since when it is unchanged. */
  private readonly unsettled = new Map<string, Unsettled>()

  constructor(private readonly options: JsonlObservationAdapterOptions) {
    this.providerId = options.providerId
    this.identify = options.identify ?? nodeFileIdentity
  }

  capabilities(): ObservedCapabilities {
    return { ...this.options.capabilities }
  }

  async discover(fs: FileSystem): Promise<SourceFile[]> {
    const own = await canonicalRoots(this.options.roots)
    const claimed = await canonicalRoots(this.options.claimedRoots)
    const byIdentity = new Map<string, SourceFile>()
    for (const root of this.options.roots) {
      for (const path of await this.walk(fs, root, 0)) {
        const file = await this.identify(path)
        if (file === null || byIdentity.has(file.fileIdentity)) continue
        if (!dispatchedTo(file.canonicalPath, own, claimed)) continue
        const streamId = `${this.providerId}:${hash(file.canonicalPath)}`
        this.paths.set(streamId, file.canonicalPath)
        byIdentity.set(file.fileIdentity, {
          streamId,
          adapterId: this.providerId,
          path: file.canonicalPath,
          fileIdentity: file.fileIdentity,
          size: file.size
        })
      }
    }
    return [...byIdentity.values()]
  }

  async read(
    source: SourceFile,
    from: Cursor | null
  ): Promise<{ events: ObservedEvent[]; next: Cursor; warnings: string[] }> {
    const start = from === null ? 0 : from.value
    const nothing = { events: [], next: this.cursorAt(start, source), warnings: [] }
    const before = await this.options.fs.stat(source.path)
    if (before === null || before.size <= start) return nothing
    const unread = before.size - start
    const gated = unread > OBSERVATION_TAIL_GATE_BYTES
    const length = gated ? OBSERVATION_TAIL_GATE_BYTES : unread
    const readFrom = before.size - length
    const text = await this.options.fs.readTextTail(source.path, length)
    const after = await this.options.fs.stat(source.path)
    // Written to during the read: the tail is not the bytes this cursor expects. Next poll.
    if (after === null || after.size !== before.size) return nothing

    const tail = splitTail(text, readFrom, gated && readFrom > 0)
    const lines = [...tail.lines]
    let consumed = readFrom + tail.consumed
    if (tail.fragment !== null) {
      if (this.settled(source.streamId, before.size)) {
        lines.push(tail.fragment)
        consumed = before.size
        this.unsettled.delete(source.streamId)
      }
    } else {
      this.unsettled.delete(source.streamId)
    }

    const events: ObservedEvent[] = []
    const warnings: string[] = []
    for (const line of lines) {
      if (line.text.trim() === '') continue
      const parsed = this.options.parse({
        text: line.text,
        offset: line.offset,
        streamId: source.streamId,
        adapterId: this.providerId
      })
      if (parsed === null) warnings.push(`unreadable line at byte ${line.offset}`)
      else events.push(...parsed)
    }
    return { events, next: this.cursorAt(Math.max(start, consumed), source), warnings }
  }

  async entries(
    ref: ObservedSessionRef,
    window: { before?: string; limit: number }
  ): Promise<TranscriptEntry[]> {
    const rows: TranscriptEntry[] = []
    for (const streamId of ref.streamIds) {
      const path = this.paths.get(streamId.replace(/#\d+$/, ''))
      if (path === undefined) continue
      rows.push(...(await this.windowOf(path, streamId, window)))
    }
    return pageBefore(rows, (row) => row.sourceKey, window)
  }

  /** The entries of the newest window of `path` that answers `window`, oldest first. */
  private async windowOf(
    path: string,
    streamId: string,
    window: { before?: string; limit: number }
  ): Promise<TranscriptEntry[]> {
    const info = await this.options.fs.stat(path)
    if (info === null) return []
    let rows: TranscriptEntry[] = []
    for (const step of FEED_WINDOW_STEPS) {
      let text: string
      try {
        text = await this.options.fs.readTextTail(path, step)
      } catch {
        return []
      }
      const partial = step < info.size
      const tail = splitTail(text, info.size - Math.min(step, info.size), partial)
      const lines = tail.fragment === null ? tail.lines : [...tail.lines, tail.fragment]
      rows = lines.flatMap((line) =>
        (
          this.options.parse({
            text: line.text,
            offset: line.offset,
            streamId,
            adapterId: this.providerId
          }) ?? []
        ).flatMap((event) => (event.kind === 'entries' ? event.entries : []))
      )
      if (!partial || !needsWiderWindow(rows, (row) => row.sourceKey, window)) break
    }
    return rows
  }

  /** Whether a stream's unterminated last line has stopped changing for the settle time. */
  private settled(streamId: string, size: number): boolean {
    const now = this.options.clock.now()
    const seen = this.unsettled.get(streamId)
    if (seen === undefined || seen.size !== size) {
      this.unsettled.set(streamId, { size, since: now })
      return false
    }
    return now - seen.since >= OBSERVATION_SETTLE_MS
  }

  private cursorAt(value: number, source: SourceFile): Cursor {
    return {
      adapterId: this.providerId,
      kind: 'byte-offset',
      value,
      fileIdentity: source.fileIdentity
    }
  }

  /** The matching files under `dir`, `depth` levels below a root; [] for an unreadable folder. */
  private async walk(fs: FileSystem, dir: string, depth: number): Promise<string[]> {
    let entries: Awaited<ReturnType<FileSystem['listDir']>>
    try {
      entries = await fs.listDir(dir)
    } catch {
      return []
    }
    const found: string[] = []
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory) {
        if (depth < MAX_DEPTH) found.push(...(await this.walk(fs, path, depth + 1)))
      } else if (this.options.matches(entry.name)) {
        found.push(path)
      }
    }
    return found.sort()
  }
}

async function canonicalRoots(roots: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const root of roots) {
    const canonical = await canonicalRoot(root)
    if (canonical !== null) out.push(canonical)
  }
  return out
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}
