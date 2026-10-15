// L8 OS lane (17 §1.8; ADR-013 item 3; C-13): the per-launch credential file of
// `RunDirCredentialFileStore` on a real disk. POSIX: the file is `0600` in a `0700` `run/mcp/`
// (narrowed when it already existed wider), and a link planted at the path is refused, never
// written through. Windows: the modes do nothing, so the file inherits the owner-only protected
// DACL the boot gives the Host data directory (owner amendment of 2026-10-01, ISSUE-041; SP-05
// run\ row): the user and SYSTEM, nobody else.
//
// Owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15, A14-04: the test is on the delegation
// port `CredentialFileStore`, not the kernel `FileSystem`.
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LaunchId } from '../../../../kernel/domain/values'
import { createNativeOwnerOnlyDirectory } from '../../../../platform/endpoint/win-pipe/nativeOwnerOnlyDirectory'
import {
  createWindowsAclReader,
  SYSTEM_SID,
  type AclView,
  type WindowsAclReader
} from '../../../../platform/endpoint/win-pipe/testing/windowsAcl'
import { RunDirCredentialFileStore } from './RunDirCredentialFileStore'

const LAUNCH = '00000000-0000-7000-8000-0000000d5a01' as LaunchId
const PREBUILDS = fileURLToPath(new URL('../../../../../../prebuilds', import.meta.url))

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function hostDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dwarfai-198-os-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const modeOf = (path: string): number => statSync(path).mode & 0o777

describe.runIf(process.platform !== 'win32')(
  'the credential file on POSIX (ADR-013 item 3)',
  () => {
    it('[C-13] the credential file is 0600 in a 0700 directory', async () => {
      const root = hostDataDir()
      const store = new RunDirCredentialFileStore({ hostDataDir: root })

      const written = await store.write(LAUNCH, randomBytes(32).toString('hex'))

      if (!written.ok) throw new Error(`expected the write to succeed, got ${written.error}`)
      expect(modeOf(written.value.path).toString(8)).toBe('600')
      expect(modeOf(join(root, 'run', 'mcp')).toString(8)).toBe('700')
    })

    it('[C-13] a wider run/mcp directory is narrowed to 0700 before the file is created', async () => {
      const root = hostDataDir()
      mkdirSync(join(root, 'run', 'mcp'), { recursive: true })
      chmodSync(join(root, 'run', 'mcp'), 0o755)

      const written = await new RunDirCredentialFileStore({ hostDataDir: root }).write(
        LAUNCH,
        randomBytes(32).toString('hex')
      )

      expect(written.ok).toBe(true)
      expect(modeOf(join(root, 'run', 'mcp')).toString(8)).toBe('700')
    })

    it('[C-13] a link planted at the credential path is refused, never written through', async () => {
      const root = hostDataDir()
      mkdirSync(join(root, 'run', 'mcp'), { recursive: true })
      const victim = join(root, 'victim.txt')
      writeFileSync(victim, 'untouched')
      symlinkSync(victim, join(root, 'run', 'mcp', `${LAUNCH}.cred`))

      const written = await new RunDirCredentialFileStore({ hostDataDir: root }).write(
        LAUNCH,
        randomBytes(32).toString('hex')
      )

      expect(written).toStrictEqual({ ok: false, error: 'exists' })
      expect(readFileSync(victim, 'utf8')).toBe('untouched')
    })
  }
)

describe.runIf(process.platform === 'win32')(
  'the credential file on Windows (SP-05 run\\ row; ISSUE-041 amendment)',
  () => {
    let reader: WindowsAclReader

    beforeAll(async () => {
      reader = await createWindowsAclReader()
    }, 180_000)
    afterAll(() => reader?.dispose())

    const entries = (acl: AclView | undefined): string[] =>
      (acl?.rules ?? [])
        .map((rule) => `${rule.type} ${rule.sid} ${rule.inherited ? 'inherited' : 'own'}`)
        .sort()

    it('[C-13] the credential file is readable by the user and SYSTEM only, inherited from the owner-only Host data directory', async () => {
      const root = hostDataDir()
      createNativeOwnerOnlyDirectory({ prebuildsDir: PREBUILDS })(root)

      const written = await new RunDirCredentialFileStore({ hostDataDir: root }).write(
        LAUNCH,
        randomBytes(32).toString('hex')
      )

      if (!written.ok) throw new Error(`expected the write to succeed, got ${written.error}`)
      const [dir, file] = await reader.read([join(root, 'run', 'mcp'), written.value.path])
      const ownerOnly = [`Allow ${SYSTEM_SID} inherited`, `Allow ${reader.user} inherited`].sort()
      expect(entries(dir)).toEqual(ownerOnly)
      expect(entries(file)).toEqual(ownerOnly)
    }, 60_000)
  }
)
