import type { Shell } from 'electron'
import { externalLinkOf } from '@dwarfai/contracts'
import type { ExternalOpener } from '../ports/nativeActions'

/** The rejection of an address the allowlist does not admit; nothing was opened. */
export class ExternalLinkRefused extends Error {
  constructor() {
    super('not an address this app opens')
    this.name = 'ExternalLinkRefused'
  }
}

/**
 * `ExternalOpener` over Electron's `shell` (05 §3.14 ← `shell/openExternalLink.ts`; 16 §4.14). It is the door from a
 * renderer's word to another program, so it runs the allowlist itself: an address reaches `shell.openExternal` only
 * when `externalLinkOf` admits it (http/https, at most 2048 characters; ADR-019 item 2, 18 C-02), the same rule from
 * `contracts/text` that the navigation guard's `setWindowOpenHandler` runs. Anything else is refused by rejecting,
 * and so is an address the OS will not open: a renderer's word is never a permission.
 */
export class ElectronExternalOpener implements ExternalOpener {
  constructor(private readonly shell: Pick<Shell, 'openExternal' | 'openPath'>) {}

  /** Electron answers the OS's error text, empty when the path opened; the port answers `null` for that. */
  async openPath(p: string): Promise<string | null> {
    const error = await this.shell.openPath(p)
    return error === '' ? null : error
  }

  async openExternal(url: string): Promise<void> {
    const safe = externalLinkOf(url)
    if (safe === null) throw new ExternalLinkRefused()
    await this.shell.openExternal(safe)
  }
}
