// L8 Windows (17 §1.8): `protectDirectory` of the native helper, built (`pnpm build:native`) and
// loaded in this process, over real directories. The DACLs are read back with full SIDs
// (testing/windowsAcl.ts).
//
// Owner-approved amendment (2026-10-01, ISSUE-041): protected owner-only DACL on the Windows data
// directory (SP-05 run\ row), replacing 09 §9's inherited profile ACL.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createNativeOwnerOnlyDirectory, type OwnerOnlyDirectory } from './nativeOwnerOnlyDirectory'
import {
  currentWindowsToken,
  grantRead,
  readWindowsAcls,
  SYSTEM_SID,
  type AclView
} from './testing/windowsAcl'

const PREBUILDS = fileURLToPath(new URL('../../../../../prebuilds', import.meta.url))
/** BUILTIN\Users: the third party the tests plant (every local account is one of them). */
const USERS_SID = 'S-1-5-32-545'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dwarfai-041-dacl-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const entries = (acl: AclView | undefined): string[] =>
  (acl?.rules ?? [])
    .map((rule) => `${rule.type} ${rule.sid} ${rule.inherited ? 'inherited' : 'own'}`)
    .sort()

describe.runIf(process.platform === 'win32')(
  'the native owner-only data directory (ISSUE-041 amendment; SP-05 run\\ row)',
  () => {
    let protect: OwnerOnlyDirectory
    let user: string

    beforeAll(async () => {
      protect = createNativeOwnerOnlyDirectory({ prebuildsDir: PREBUILDS })
      user = (await currentWindowsToken()).user
    }, 60_000)

    it('[ADR-017] protectDirectory gives a directory the protected DACL of the user and SYSTEM, which a file created later inherits', async () => {
      const dir = freshDir()

      expect(protect(dir)).toBe('repaired')
      writeFileSync(join(dir, 'dwarfai.db'), '')
      const [own, child] = await readWindowsAcls([dir, join(dir, 'dwarfai.db')])

      expect(own?.protected).toBe(true)
      expect(entries(own)).toEqual([`Allow ${SYSTEM_SID} own`, `Allow ${user} own`].sort())
      expect(entries(child)).toEqual(
        [`Allow ${SYSTEM_SID} inherited`, `Allow ${user} inherited`].sort()
      )
    }, 60_000)

    it('[ADR-017] files and folders the directory already held become owner-only too', async () => {
      const dir = freshDir()
      // A third party passed down to everything the directory holds, as %APPDATA% may do.
      await grantRead(dir, USERS_SID, { inherit: true })
      mkdirSync(join(dir, 'run'))
      writeFileSync(join(dir, 'dwarfai.db'), '')
      writeFileSync(join(dir, 'run', 'ui.token'), '')
      const paths = [join(dir, 'dwarfai.db'), join(dir, 'run'), join(dir, 'run', 'ui.token')]
      const before = await readWindowsAcls(paths)
      expect(before.every((acl) => acl.rules.some((rule) => rule.sid === USERS_SID))).toBe(true)

      expect(protect(dir)).toBe('repaired')

      for (const [index, acl] of (await readWindowsAcls(paths)).entries()) {
        expect(entries(acl), paths[index]).toEqual(
          [`Allow ${SYSTEM_SID} inherited`, `Allow ${user} inherited`].sort()
        )
      }
    }, 60_000)

    it('[ADR-017] a directory that already has the protected DACL is left alone', async () => {
      const dir = freshDir()
      expect(protect(dir)).toBe('repaired')

      expect(protect(dir)).toBe('unchanged')
      expect(protect(dir)).toBe('unchanged')
    }, 60_000)

    it('[ADR-017] a third-party entry added to a protected directory is removed by the next call', async () => {
      const dir = freshDir()
      expect(protect(dir)).toBe('repaired')
      await grantRead(dir, USERS_SID, { inherit: true })

      expect(protect(dir)).toBe('repaired')
      const [own] = await readWindowsAcls([dir])

      expect(own?.protected).toBe(true)
      expect(entries(own)).toEqual([`Allow ${SYSTEM_SID} own`, `Allow ${user} own`].sort())
    }, 60_000)
  }
)
