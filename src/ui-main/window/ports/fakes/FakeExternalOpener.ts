import { externalLinkOf } from '@dwarfai/contracts'
import type { ExternalOpener } from '../nativeActions'

/**
 * Hand-written double of `ExternalOpener` (16 §4.14, 16 §2.8). Every address and path it was asked to open is
 * recorded. Like the real opener it runs the `externalLinkOf` allowlist itself (ADR-019 item 2): an address it does not
 * admit rejects and is never recorded as opened. `refuse` plays an OS that will not open an admitted address, so
 * `openExternal` rejects too (the ExternalOpener contract, ../externalOpener.contract.ts).
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
    if (externalLinkOf(url) === null)
      return Promise.reject(new Error('not an address this app opens'))
    if (this.refuse) return Promise.reject(new Error(`refused: ${url}`))
    this.opened.push(url)
    return Promise.resolve()
  }
}
