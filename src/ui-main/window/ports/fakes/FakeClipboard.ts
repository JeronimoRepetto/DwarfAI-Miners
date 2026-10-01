import type { ClipboardPort } from '../nativeActions'

/**
 * Hand-written double of `ClipboardPort` (16 §4.14, 16 §2.8). Every write is recorded, so a refusal can be seen to
 * have written nothing; `failWith` plays a platform clipboard that throws.
 */
export class FakeClipboard implements ClipboardPort {
  readonly written: string[] = []
  failWith: Error | null = null

  write(text: string): void {
    if (this.failWith !== null) throw this.failWith
    this.written.push(text)
  }
}
