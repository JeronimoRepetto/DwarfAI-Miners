import type { Clipboard } from 'electron'
import type { ClipboardPort } from '../ports/nativeActions'

/**
 * `ClipboardPort` over Electron's `clipboard` (05 §3.14 ← `shell/copyText.ts`; 16 §4.14). The text goes to the
 * system clipboard as written; on Linux that is the CLIPBOARD selection, the one Ctrl+V pastes. Electron 44's
 * `writeText` answers a promise while the frozen port's `write` returns nothing, so the write is handed over and not
 * awaited: a write the platform refuses synchronously throws to the caller (`copyText` answers not copied), and one
 * that is refused later is caught here, so it never surfaces as an unhandled rejection in UI main.
 */
export class ElectronClipboard implements ClipboardPort {
  constructor(private readonly clipboard: Pick<Clipboard, 'writeText'>) {}

  write(text: string): void {
    this.clipboard.writeText(text).catch(() => undefined)
  }
}
