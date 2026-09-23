import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NodeHookFs } from './hookFs'

/**
 * Real-disk proof for the owner-only write (#588 T6 security fix). The unit
 * tests over FakeHookFs (hookToken.test.ts, openCodePluginInstaller.test.ts)
 * prove `writeSecretText` is the call actually made; this proves the OS
 * really restricts the resulting file the way that call asks it to.
 *
 * POSIX-only, same real-disk exception `fsAdapter.test.ts`'s `NodeFs` suite
 * already uses: Windows has no POSIX permission bits for `mode` to set --
 * Node maps it there to the read-only attribute only, and per-user ACLs on a
 * profile directory already keep other accounts out (see hookFs.ts and the
 * platform-ports skill). Reading `process.platform` here gates which
 * assertion is MEANINGFUL on this host's real filesystem, not a per-OS
 * behaviour branch, so it stays in the test rather than becoming a parameter.
 */
describe('NodeHookFs.writeSecretText (#588 T6)', () => {
  let dir: string
  const fs = new NodeHookFs()

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwarfai-hookfs-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'writes a secret file readable only by its owner',
    async () => {
      const path = join(dir, 'secret.txt')
      await fs.writeSecretText(path, 'a-secret')
      const mode = (await stat(path)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'tightens an existing file to owner-only, not just a freshly created one',
    async () => {
      const path = join(dir, 'existing-secret.txt')
      // A plain writeText stands in for a file that pre-dates this fix and
      // still carries a permissive mode -- writeSecretText must not trust
      // that a file already there was created owner-only.
      await fs.writeText(path, 'old')
      await fs.writeSecretText(path, 'new')
      const mode = (await stat(path)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  )
})
