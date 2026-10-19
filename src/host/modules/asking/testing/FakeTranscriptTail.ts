// The transcript-tail double (ISSUE-134): a mutable map of transcript path → text, so a test can
// change what a fresh re-read shows. Never imported by production code (R14).
//
// - A path with no text reads as `null` (unreadable), as the real tail answers.
// - `reads` counts the reads, so a test can prove the channel re-read rather than reused a cache.
// - `onRead` runs after each read, before its text is returned: the world can move during the read.
import type { TranscriptTail } from '../adapters/observedClaude/transcriptTail'

export class FakeTranscriptTail implements TranscriptTail {
  readonly texts = new Map<string, string>()
  reads = 0
  onRead: (() => void) | null = null

  set(path: string, text: string): void {
    this.texts.set(path, text)
  }

  read(path: string): Promise<string | null> {
    this.reads += 1
    const text = this.texts.get(path) ?? null
    this.onRead?.()
    return Promise.resolve(text)
  }
}
