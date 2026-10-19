import { describe, expect, it } from 'vitest'
import type { ClipboardPort } from './nativeActions'

export interface ClipboardSubject {
  clipboard: ClipboardPort
  /** Every text the system clipboard received, in order. */
  received(): string[]
  /** The platform refuses every write from now on. */
  refuseWrites(): void
}

/**
 * The `ClipboardPort` contract (16 §4.14 as amended on 2026-10-01, ISSUE-050; 16 §2.8), run by the double and by the
 * real adapter alike: `write` puts the text on the clipboard exactly as written and resolves; a write the platform
 * refuses rejects, and never throws at the call, so `copyText` can answer `copied: false`.
 */
export function runClipboardContract(name: string, make: () => ClipboardSubject): void {
  describe(`${name} meets the ClipboardPort contract (16 §4.14)`, () => {
    it('[ADR-033] write puts the text on the clipboard exactly as written, never trimmed', async () => {
      const subject = make()

      await subject.clipboard.write('  Also check\r\nthat it sorts. ')
      await subject.clipboard.write('second, with a tab\t')

      expect(subject.received()).toEqual([
        '  Also check\r\nthat it sorts. ',
        'second, with a tab\t'
      ])
    })

    it('[ADR-033] a write the platform refuses rejects; it never throws at the call', async () => {
      const subject = make()
      subject.refuseWrites()

      let pending: Promise<void> = Promise.resolve()
      expect(() => {
        pending = subject.clipboard.write('lost')
      }).not.toThrow()

      await expect(pending).rejects.toBeInstanceOf(Error)
      expect(subject.received()).toEqual([])
    })
  })
}
