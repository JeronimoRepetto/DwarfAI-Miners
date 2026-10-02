// layer: L2
import { describe, expect, it } from 'vitest'
import { ElectronClipboard } from './ElectronClipboard'
import { runClipboardContract } from '../ports/clipboard.contract'

/**
 * The real `ElectronClipboard` over a recording `clipboard` double (16 §4.14 as amended on 2026-10-01, ISSUE-050):
 * Electron 44's `writeText` answers a promise, and `write` settles with it, so a write the platform refuses after the
 * call reaches the caller.
 */
class RecordingClipboard {
  readonly written: string[] = []
  failLater: Error | null = null

  writeText(text: string): Promise<void> {
    if (this.failLater !== null) return Promise.reject(this.failLater)
    this.written.push(text)
    return Promise.resolve()
  }
}

describe('ElectronClipboard (16 §4.14)', () => {
  it('[ADR-033] write puts the text on the clipboard exactly as written', async () => {
    const clipboard = new RecordingClipboard()
    await new ElectronClipboard(clipboard).write('  Also check\nthat it sorts. ')
    expect(clipboard.written).toEqual(['  Also check\nthat it sorts. '])
  })

  it('[ADR-033] a write the platform refuses after the call rejects', async () => {
    const clipboard = new RecordingClipboard()
    clipboard.failLater = new Error('clipboard refused the write')
    await expect(new ElectronClipboard(clipboard).write('hi')).rejects.toThrow(
      'clipboard refused the write'
    )
  })
})

runClipboardContract('ElectronClipboard over Electron clipboard', () => {
  const electron = new RecordingClipboard()
  return {
    clipboard: new ElectronClipboard(electron),
    received: () => [...electron.written],
    refuseWrites: () => {
      electron.failLater = new Error('clipboard refused the write')
    }
  }
})
