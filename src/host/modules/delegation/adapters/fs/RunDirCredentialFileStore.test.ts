import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { LaunchId } from '../../../../kernel/domain/values'
import { runCredentialFileStoreContract } from '../../testing/credentialFileStore.contract'
import { RunDirCredentialFileStore } from './RunDirCredentialFileStore'

// L3 (17 §1.3): the contract over a real temp directory, one per test (17 §5.3).
describe('RunDirCredentialFileStore', () => {
  runCredentialFileStoreContract(() => {
    const hostDataDir = mkdtempSync(join(tmpdir(), 'dwarfai-198-cred-'))
    return {
      store: new RunDirCredentialFileStore({ hostDataDir }),
      read: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
      dispose: () => rmSync(hostDataDir, { recursive: true, force: true })
    }
  })
})

describe('RunDirCredentialFileStore file names', () => {
  it('[C-13] a launch id that is not a UUID never names a file, so no path leaves run/mcp', async () => {
    const hostDataDir = mkdtempSync(join(tmpdir(), 'dwarfai-198-cred-'))
    try {
      const store = new RunDirCredentialFileStore({ hostDataDir })

      await expect(store.write('../escape' as LaunchId, 'x')).rejects.toThrow(HostInvariantError)
      await expect(store.remove('../escape' as LaunchId)).rejects.toThrow(HostInvariantError)
      expect(existsSync(join(hostDataDir, 'run', 'escape.cred'))).toBe(false)
    } finally {
      rmSync(hostDataDir, { recursive: true, force: true })
    }
  })
})

describe('RunDirCredentialFileStore partial writes', () => {
  it('[C-13] a write that fails after the file was created leaves no file behind and reports the failure', async () => {
    const hostDataDir = mkdtempSync(join(tmpdir(), 'dwarfai-198-cred-'))
    try {
      // The real create, then a write that fails part-way (as a full disk would).
      const failingOpen = (async (...args: Parameters<typeof open>) => {
        const handle = await open(...args)
        return Object.assign(Object.create(handle), {
          writeFile: async () => {
            await handle.writeFile('partial', 'utf8')
            throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
          },
          close: () => handle.close()
        })
      }) as typeof open
      const store = new RunDirCredentialFileStore({ hostDataDir, open: failingOpen })
      const launch = '00000000-0000-7000-8000-0000000d7a01' as LaunchId

      expect(await store.write(launch, 'x'.repeat(64))).toStrictEqual({
        ok: false,
        error: 'no-space'
      })
      expect(readdirSync(join(hostDataDir, 'run', 'mcp'))).toStrictEqual([])
      expect(await store.list()).toStrictEqual([])
    } finally {
      rmSync(hostDataDir, { recursive: true, force: true })
    }
  })
})
