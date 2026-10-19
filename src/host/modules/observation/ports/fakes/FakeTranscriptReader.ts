// The TranscriptReader double (16 §4.3 `FakeTranscriptReader`: window paging). Never imported by
// production code (R14). A test scripts each stream's entries, oldest first; `entries` pages them
// as the adapter base does: up to `limit` entries older than `before`, oldest first, and [] for an
// unknown stream or one the test made unreadable. Type-only imports (05 R2).
import type { ObservedSessionRef } from '../observedSessionStore'
import type { TranscriptEntry, TranscriptReader } from '../transcriptReader'

export class FakeTranscriptReader implements TranscriptReader {
  private readonly byStream = new Map<string, TranscriptEntry[]>()
  private readonly unreadable = new Set<string>()

  /** The stream's transcript, oldest first. */
  script(streamId: string, entries: TranscriptEntry[]): void {
    this.byStream.set(
      streamId,
      entries.map((e) => ({ ...e }))
    )
  }

  /** The stream's file can no longer be read. */
  breakStream(streamId: string): void {
    this.unreadable.add(streamId)
  }

  entries(
    ref: ObservedSessionRef,
    window: { before?: string; limit: number }
  ): Promise<TranscriptEntry[]> {
    const rows = ref.streamIds.flatMap((id) =>
      this.unreadable.has(id) ? [] : (this.byStream.get(id) ?? [])
    )
    const end =
      window.before === undefined
        ? rows.length
        : rows.findIndex((row) => row.sourceKey === window.before)
    if (end < 0) return Promise.resolve([])
    return Promise.resolve(rows.slice(Math.max(0, end - window.limit), end).map((e) => ({ ...e })))
  }
}
