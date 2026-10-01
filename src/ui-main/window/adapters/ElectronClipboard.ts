import type { Clipboard } from 'electron'
import type { ClipboardPort } from '../ports/nativeActions'

/**
 * `ClipboardPort` over Electron's `clipboard` (05 §3.14 ← `shell/copyText.ts`; 16 §4.14). The text goes to the
 * system clipboard as written; on Linux that is the CLIPBOARD selection, the one Ctrl+V pastes. Electron 44's
 * `writeText` answers a promise, and `write` settles with it (the port as amended on 2026-10-01, ISSUE-050), so a
 * write the platform refuses, at once or later, reaches `copyText` as a failure.
 */
export class ElectronClipboard implements ClipboardPort {
  constructor(private readonly clipboard: Pick<Clipboard, 'writeText'>) {}

  async write(text: string): Promise<void> {
    await this.clipboard.writeText(text)
  }
}
