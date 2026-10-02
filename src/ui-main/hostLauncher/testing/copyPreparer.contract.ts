// The HostCopyPreparer contract (17 §1.3, 16 §2.8; ports.ts `HostCopyPreparer`, `PreparedHostCopy`; ADR-002 D5): one
// suite run by the double and by the Node copy preparer over a per-test temporary folder. The Host never runs from
// the app's install directory: a prepared copy answers the app directory it was made from and where its copy is,
// `<copy root>/<version>/`, never that directory itself nor a folder inside it; a second prepare answers the same
// copy (a verified copy is reused); a copy that cannot be made answers `ok: false` with an error code.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HostCopyPreparer } from '../ports'

export interface CopyPreparerSubject {
  prepare: HostCopyPreparer
  /** The app directory that holds the executable. */
  sourceDir: string
  /** Where this build's copy belongs: `<copy root>/<version>`. */
  copyDir: string
  /** From now on no copy can be made (for the real preparer, this build's manifest is gone). */
  breakCopy(): void
}

/** Whether `inner` is `outer` or a folder below it, on this OS's paths. */
function within(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function runCopyPreparerContract(
  name: string,
  make: () => Promise<CopyPreparerSubject>
): void {
  describe(`${name} meets the HostCopyPreparer contract (ADR-002 D5)`, () => {
    it('[ADR-002] a prepared copy answers the app directory it copies and a copy under <copy root>/<version>, never the app directory', async () => {
      const subject = await make()

      const prepared = await subject.prepare()

      if (!prepared.ok) throw new Error(`not prepared: ${prepared.errCode}`)
      expect(prepared.sourceDir).toBe(subject.sourceDir)
      expect(within(prepared.contentDir, subject.copyDir)).toBe(true)
      expect(within(prepared.contentDir, subject.sourceDir)).toBe(false)
    })

    it('[ADR-002] a second prepare answers the same copy', async () => {
      const subject = await make()

      const first = await subject.prepare()
      const second = await subject.prepare()

      expect(second).toEqual(first)
    })

    it('[ADR-002, FM-129] a copy that cannot be made answers not ok with an error code', async () => {
      const subject = await make()
      subject.breakCopy()

      expect(await subject.prepare()).toEqual({
        ok: false,
        errCode: expect.stringMatching(/^[A-Z0-9_]+$/)
      })
    })
  })
}
