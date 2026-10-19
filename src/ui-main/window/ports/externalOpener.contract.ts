import { describe, expect, it } from 'vitest'
import type { ExternalOpener } from './nativeActions'

export interface ExternalOpenerSubject {
  opener: ExternalOpener
  /** Every address the OS was asked to open, in order. */
  openedLinks(): string[]
  /** Every path the OS was asked to open, in order. */
  openedPaths(): string[]
  /** The OS will not open an address from now on. */
  osRefusesLinks(): void
  /** The OS answers `text` for every path it is asked to open from now on. */
  osPathError(text: string): void
}

/**
 * The `ExternalOpener` contract (16 §4.14, 16 §2.8; ADR-019 item 2, 18 C-02), run by the double and by the real
 * adapter alike. `openExternal` opens an address the `externalLinkOf` allowlist admits (http or https, at most 2048
 * characters) and rejects any other without asking the OS, since the opener is the door from a renderer's word to
 * another program; an address the OS will not open rejects too. `openPath` answers `null` when the path opened and
 * the OS's error text otherwise.
 */
export function runExternalOpenerContract(name: string, make: () => ExternalOpenerSubject): void {
  describe(`${name} meets the ExternalOpener contract (16 §4.14)`, () => {
    it('[ADR-019] an http or https address is opened', async () => {
      const subject = make()

      await subject.opener.openExternal('https://example.org/docs?q=1')
      await subject.opener.openExternal('http://example.org/')

      expect(subject.openedLinks()).toEqual(['https://example.org/docs?q=1', 'http://example.org/'])
    })

    it('[ADR-019] an address the allowlist refuses rejects and never reaches the OS', async () => {
      const subject = make()

      for (const refused of [
        'file:///etc/passwd',
        'javascript:alert(1)',
        'ms-settings:privacy',
        `https://example.org/${'a'.repeat(2_048)}`
      ]) {
        await expect(subject.opener.openExternal(refused), refused).rejects.toBeInstanceOf(Error)
      }

      expect(subject.openedLinks()).toEqual([])
    })

    it('[ADR-019] an address the OS will not open rejects', async () => {
      const subject = make()
      subject.osRefusesLinks()

      await expect(subject.opener.openExternal('https://example.org/')).rejects.toBeInstanceOf(
        Error
      )
    })

    it('[ADR-019] openPath answers null when the path opened and the OS error text otherwise', async () => {
      const subject = make()

      expect(await subject.opener.openPath('C:/work/notes')).toBeNull()
      subject.osPathError('Failed to open path')
      expect(await subject.opener.openPath('C:/work/gone')).toBe('Failed to open path')

      expect(subject.openedPaths()).toEqual(['C:/work/notes', 'C:/work/gone'])
    })
  })
}
