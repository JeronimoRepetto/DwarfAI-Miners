// layer: L2
import { describe, expect, it } from 'vitest'
import { MAX_EXTERNAL_LINK_CHARS } from '@dwarfai/contracts'
import { createNativeActions } from '../application/nativeActions'
import { FakeClipboard } from '../ports/fakes/FakeClipboard'
import { FakeFilePicker } from '../ports/fakes/FakeFilePicker'
import { ElectronExternalOpener } from './ElectronExternalOpener'
import { runExternalOpenerContract } from '../ports/externalOpener.contract'

/**
 * The real `ElectronExternalOpener` over a recording `shell` double (ADR-019 item 2; 18 C-02): only an address the
 * `externalLinkOf` allowlist admits (http/https, at most 2048 characters) ever reaches `shell.openExternal`, the same
 * allowlist the navigation guard's `setWindowOpenHandler` runs. Driven through `openExternal` of the window module's
 * native actions, which answers A-21's `ExternalLinkResult`.
 */

class RecordingShell {
  readonly opened: string[] = []
  readonly openedPaths: string[] = []
  failOpen: Error | null = null
  openPathAnswer = ''

  openExternal(url: string): Promise<void> {
    if (this.failOpen !== null) return Promise.reject(this.failOpen)
    this.opened.push(url)
    return Promise.resolve()
  }

  openPath(p: string): Promise<string> {
    this.openedPaths.push(p)
    return Promise.resolve(this.openPathAnswer)
  }
}

function subject() {
  const shell = new RecordingShell()
  const opener = new ElectronExternalOpener(shell)
  const actions = createNativeActions({
    files: new FakeFilePicker(null),
    clipboard: new FakeClipboard(),
    opener,
    parentWindow: () => ({ windowId: 1 })
  })
  return { shell, opener, actions }
}

const REFUSED = { opened: false, reason: 'That link could not be opened.' }

describe('ElectronExternalOpener (16 §4.14; ADR-019 item 2)', () => {
  it('[ADR-019] javascript:, file:, data: and a 2049-character URL are refused and never opened', async () => {
    const { shell, opener, actions } = subject()
    const tooLong = `https://example.test/${'a'.repeat(MAX_EXTERNAL_LINK_CHARS)}`.slice(
      0,
      MAX_EXTERNAL_LINK_CHARS + 1
    )
    expect(tooLong).toHaveLength(2049)
    const refused = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      tooLong
    ]

    for (const url of refused) {
      expect(await actions.openExternal(url), url).toEqual(REFUSED)
      await expect(opener.openExternal(url), url).rejects.toThrow()
    }
    expect(shell.opened).toEqual([])
  })

  it('[ADR-019] an https URL opens once and answers opened', async () => {
    const { shell, actions } = subject()
    const url = 'https://example.test/docs?q=1#part'

    expect(await actions.openExternal(url)).toEqual({ opened: true })
    // The raw address the person saw, not the parser's canonical form (contracts/text externalLink).
    expect(shell.opened).toEqual([url])
  })

  it('[ADR-019] a link the OS refuses to open answers the legacy failure shape', async () => {
    const { shell, actions } = subject()
    shell.failOpen = new Error('no handler for https')

    expect(await actions.openExternal('https://example.test/')).toEqual(REFUSED)
  })

  it('[ADR-019] openPath answers null when the path opened and the OS error text otherwise', async () => {
    const { shell, opener } = subject()
    const path = '/home/j/mine/notes.md'

    expect(await opener.openPath(path)).toBeNull()
    shell.openPathAnswer = 'Failed to open path'
    expect(await opener.openPath(path)).toBe('Failed to open path')
    expect(shell.openedPaths).toEqual([path, path])
  })
})

runExternalOpenerContract('ElectronExternalOpener over Electron shell', () => {
  const shell = new RecordingShell()
  return {
    opener: new ElectronExternalOpener(shell),
    openedLinks: () => [...shell.opened],
    openedPaths: () => [...shell.openedPaths],
    osRefusesLinks: () => {
      shell.failOpen = new Error('no handler for the address')
    },
    osPathError: (text) => {
      shell.openPathAnswer = text
    }
  }
})
