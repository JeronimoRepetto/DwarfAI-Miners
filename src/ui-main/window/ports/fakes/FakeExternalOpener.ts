import type { ExternalOpener } from '../nativeActions'

/**
 * Hand-written double of `ExternalOpener` (16 §4.14, 16 §2.8). Every address and path it was asked to open is
 * recorded; `refuse` plays an opener that refuses (the adapter's allowlist, or the OS), so `openExternal` rejects.
 * `openPathError` is the OS's error text `openPath` answers, `null` when the path opened.
 */
export class FakeExternalOpener implements ExternalOpener {
  readonly opened: string[] = []
  readonly openedPaths: string[] = []
  refuse = false
  openPathError: string | null = null

  openPath(p: string): Promise<string | null> {
    this.openedPaths.push(p)
    return Promise.resolve(this.openPathError)
  }

  openExternal(url: string): Promise<void> {
    if (this.refuse) return Promise.reject(new Error(`refused: ${url}`))
    this.opened.push(url)
    return Promise.resolve()
  }
}
