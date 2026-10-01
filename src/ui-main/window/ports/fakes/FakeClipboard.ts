import type { ClipboardPort } from '../nativeActions'

/**
 * Hand-written double of `ClipboardPort` (16 §4.14, 16 §2.8). Every write is recorded, so a refusal can be seen to
 * have written nothing; `failWith` plays a platform clipboard whose write fails, `failLater` one whose write is
 * handed over and fails afterwards (the promise rejects).
 */
export class FakeClipboard implements ClipboardPort {
  readonly written: string[] = []
  failWith: Error | null = null
  failLater: Error | null = null

  write(text: string): Promise<void> {
    if (this.failWith !== null) throw this.failWith
    if (this.failLater !== null) return Promise.reject(this.failLater)
    this.written.push(text)
    return Promise.resolve()
  }
}
