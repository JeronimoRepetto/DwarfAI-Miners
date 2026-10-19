// The SourceWeightScanner conformance suite (16 §4.1 row `SourceWeightScanner`, 16 §2.8, 17 §1.3):
// run against FakeSourceWeightScanner over FakeFs and against FsSourceWeightScanner over a small
// temporary tree, so a use case tested with the double sees what the disk would give it. Each file
// is written with content of its own, so no two files are byte-identical.
import { describe, expect, it } from 'vitest'
import type { FolderPath } from '../../../kernel/domain/values'
import type { SourceWeightScanner } from '../ports/sourceWeightScanner'

export interface SourceWeightScannerSubject {
  readonly scanner: SourceWeightScanner
  /** An existing, empty folder the tree is written under. */
  readonly root: string
  /** `root` and the relative segments, joined with the subject's separator. */
  at(...segments: string[]): FolderPath
  /** Writes a file of exactly `bytes` bytes (parents included); `relative` is written with `/`. */
  write(relative: string, bytes: number): Promise<void>
  /**
   * Suspends every walk before it reads anything, until the returned function is called. A
   * subject without it is aborted in the same tick it starts, before its worker can answer.
   */
  readonly hold?: () => () => void
}

export function runSourceWeightScannerContract(
  name: string,
  makeSubject: () => Promise<SourceWeightScannerSubject>
): void {
  describe(`SourceWeightScanner contract: ${name}`, () => {
    it('[BR-15] only source-ish files count and node_modules and dist are skipped', async () => {
      const subject = await makeSubject()
      await subject.write('src/a.ts', 100)
      await subject.write('src/deep/b.vue', 200)
      await subject.write('c.py', 50)
      // Not source-ish: never counted, whatever their size.
      await subject.write('README.md', 1_000)
      await subject.write('pnpm-lock.yaml', 1_000)
      // Source-ish, but under a skipped directory.
      await subject.write('node_modules/pkg/index.js', 400)
      await subject.write('dist/out.js', 300)
      await subject.write('src/dist/nested.ts', 500)

      const result = await subject.scanner.measure(subject.at(), new AbortController().signal)

      expect(result).toEqual({ bytes: 350 })
    })

    it('[ADR-030] an abort mid-scan resolves without a weight', async () => {
      const subject = await makeSubject()
      await subject.write('src/a.ts', 100)
      const resume = subject.hold?.()
      const controller = new AbortController()

      const measuring = subject.scanner.measure(subject.at(), controller.signal)
      controller.abort()
      const result = await measuring
      resume?.()

      expect(result).not.toHaveProperty('bytes')
      expect(result).toEqual({ unenterable: 'aborted' })
      // A call made with a signal already aborted does not walk either.
      await expect(subject.scanner.measure(subject.at(), controller.signal)).resolves.toEqual({
        unenterable: 'aborted'
      })
    })

    it('[BR-15] a root that cannot be read answers unenterable with the reason', async () => {
      const subject = await makeSubject()
      await subject.write('src/a.ts', 100)

      const result = await subject.scanner.measure(subject.at('gone'), new AbortController().signal)

      expect(result).toEqual({ unenterable: 'not-found' })
    })
  })
}
