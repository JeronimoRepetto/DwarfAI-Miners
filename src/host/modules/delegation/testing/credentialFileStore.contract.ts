// The CredentialFileStore conformance suite (owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15,
// A14-04; ADR-013 item 3; 17 §1.3): run on the in-memory double and on the run-directory adapter
// over a temp dir. `write` creates the launch's credential file exclusively and returns its path
// (`'exists'` when one is there, which is never overwritten); `remove` of a missing file succeeds;
// `list` gives the launch ids of the files present. The file modes and the Windows ACL are the OS
// lane's (credentialFile.os.test.ts). Never imported by production code (R14).
//
// The credentials are drawn at run time, so no credential value is written into the repository.
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { LaunchId } from '../../../kernel/domain/values'
import type { CredentialFileStore } from '../ports/delegationStores'

const LAUNCH = '00000000-0000-7000-8000-0000000d4a01' as LaunchId
const OTHER_LAUNCH = '00000000-0000-7000-8000-0000000d4a02' as LaunchId

export interface CredentialFileStoreSubject {
  store: CredentialFileStore
  /** The text of the file at `path`, or null when there is none. */
  read(path: string): string | null
  dispose(): void | Promise<void>
}

function drawCredential(): string {
  return randomBytes(32).toString('hex')
}

/** The path's last three segments, whichever separator the platform uses. */
function tail(path: string): string {
  return path.split(/[\\/]/).slice(-3).join('/')
}

export function runCredentialFileStoreContract(
  makeSubject: () => CredentialFileStoreSubject | Promise<CredentialFileStoreSubject>
): void {
  describe('CredentialFileStore contract', () => {
    let subject: CredentialFileStoreSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async (): Promise<CredentialFileStoreSubject> => {
      subject = await makeSubject()
      return subject
    }

    it('[C-13, C-15] write creates the launch credential file holding the credential and returns its path, named after the launch', async () => {
      const s = await setUp()
      const credential = drawCredential()

      const written = await s.store.write(LAUNCH, credential)

      if (!written.ok) throw new Error(`expected the write to succeed, got ${written.error}`)
      expect(tail(written.value.path)).toBe(`run/mcp/${LAUNCH}.cred`)
      expect(s.read(written.value.path)).toBe(credential)
    })

    it('[C-13] a second write for the same launch is exists and the first credential stays', async () => {
      const s = await setUp()
      const first = drawCredential()
      const written = await s.store.write(LAUNCH, first)
      if (!written.ok) throw new Error(`expected the write to succeed, got ${written.error}`)

      expect(await s.store.write(LAUNCH, drawCredential())).toStrictEqual({
        ok: false,
        error: 'exists'
      })
      expect(s.read(written.value.path)).toBe(first)
    })

    it('[ADR-013] list gives the launch ids of the files present, and remove deletes a file once; removing a missing file succeeds', async () => {
      const s = await setUp()
      expect(await s.store.list()).toStrictEqual([])
      const written = await s.store.write(OTHER_LAUNCH, drawCredential())
      await s.store.write(LAUNCH, drawCredential())
      if (!written.ok) throw new Error(`expected the write to succeed, got ${written.error}`)

      expect(await s.store.list()).toStrictEqual([LAUNCH, OTHER_LAUNCH])

      await s.store.remove(OTHER_LAUNCH)
      await s.store.remove(OTHER_LAUNCH)

      expect(s.read(written.value.path)).toBeNull()
      expect(await s.store.list()).toStrictEqual([LAUNCH])
    })
  })
}
