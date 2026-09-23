import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fakeSafeStorage } from '../adapters/fakeSafeStorage'
import {
  createOpenCodeServerPasswordStore,
  OPENCODE_PASSWORD_FILE,
  type OpenCodePasswordFsLike
} from './openCodeServerPassword'

/**
 * The OpenCode server password Settings carries (#588 T6, F1): optional, a
 * secret, and therefore stored the way `jevApiKey.ts` stores the only other
 * secret this app holds — ciphertext behind the `safeStorage` port, never a
 * plaintext fallback, and never answered to the renderer.
 */
const USER_DATA_DIR = 'C:/fake/userData'
const FILE = join(USER_DATA_DIR, OPENCODE_PASSWORD_FILE)

function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const fs: OpenCodePasswordFsLike = {
    readFile: async (path) => {
      const content = files.get(path)
      if (content === undefined)
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return content
    },
    writeFile: async (path, data) => {
      files.set(path, data)
    },
    rename: async (from, to) => {
      const content = files.get(from)
      if (content === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, content)
    }
  }
  return { fs, files }
}

describe('createOpenCodeServerPasswordStore (#588 T6, F1)', () => {
  it('answers unconfigured on a first run -- empty means no auth, OpenCode’s own default', async () => {
    const store = createOpenCodeServerPasswordStore({
      userDataDir: USER_DATA_DIR,
      fs: fakeFs().fs,
      safeStorage: fakeSafeStorage()
    })
    expect(await store.load()).toEqual({ configured: false })
    expect(store.readPassword()).toBeUndefined()
  })

  it('stores ciphertext only, and hands the plaintext back to main alone', async () => {
    const { fs, files } = fakeFs()
    const store = createOpenCodeServerPasswordStore({
      userDataDir: USER_DATA_DIR,
      fs,
      safeStorage: fakeSafeStorage()
    })
    expect(await store.save('hunter2')).toEqual({ saved: true })
    expect(files.get(FILE)).not.toContain('hunter2')
    expect(store.readPassword()).toBe('hunter2')
    expect(await store.load()).toEqual({ configured: true })
  })

  it('keeps the password exactly as typed -- spaces are part of a password, not padding', async () => {
    const store = createOpenCodeServerPasswordStore({
      userDataDir: USER_DATA_DIR,
      fs: fakeFs().fs,
      safeStorage: fakeSafeStorage()
    })
    await store.save(' pass word ')
    expect(store.readPassword()).toBe(' pass word ')
  })

  it('survives a relaunch: a fresh store over the same file reads the same password', async () => {
    const { fs } = fakeFs()
    const safeStorage = fakeSafeStorage()
    await createOpenCodeServerPasswordStore({ userDataDir: USER_DATA_DIR, fs, safeStorage }).save(
      'x'
    )
    const relaunched = createOpenCodeServerPasswordStore({
      userDataDir: USER_DATA_DIR,
      fs,
      safeStorage
    })
    expect(await relaunched.load()).toEqual({ configured: true })
    expect(relaunched.readPassword()).toBe('x')
  })

  it('refuses an empty password rather than storing one -- clearing is how the field goes empty', async () => {
    const store = createOpenCodeServerPasswordStore({
      userDataDir: USER_DATA_DIR,
      fs: fakeFs().fs,
      safeStorage: fakeSafeStorage()
    })
    expect(await store.save('')).toEqual({ saved: false, reason: 'empty' })
  })

  it('refuses to store anything, with the reason, where this machine offers no encryption', async () => {
    const { fs, files } = fakeFs()
    const store = createOpenCodeServerPasswordStore({
      userDataDir: USER_DATA_DIR,
      fs,
      safeStorage: fakeSafeStorage({ available: false })
    })
    expect(await store.save('hunter2')).toEqual({ saved: false, reason: 'encryption-unavailable' })
    expect(files.size).toBe(0)
    expect(await store.load()).toEqual({
      configured: false,
      unavailableReason: 'encryption-unavailable'
    })
  })

  it('forgets the password on disk and in memory when cleared', async () => {
    const { fs } = fakeFs()
    const safeStorage = fakeSafeStorage()
    const store = createOpenCodeServerPasswordStore({ userDataDir: USER_DATA_DIR, fs, safeStorage })
    await store.save('hunter2')
    await store.clear()
    expect(store.readPassword()).toBeUndefined()
    expect(await store.load()).toEqual({ configured: false })
  })

  it('degrades an undecryptable file to unconfigured, and warns by name, instead of failing startup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { fs } = fakeFs({ [FILE]: JSON.stringify({ encrypted: 'bm90LW91cnM=' }) })
      const store = createOpenCodeServerPasswordStore({
        userDataDir: USER_DATA_DIR,
        fs,
        safeStorage: fakeSafeStorage()
      })
      expect(await store.load()).toEqual({ configured: false })
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/opencode/i)
      // The warning names the file's purpose, never its content.
      expect(JSON.stringify(warn.mock.calls)).not.toContain('bm90LW91cnM=')
    } finally {
      warn.mockRestore()
    }
  })

  it('degrades an unparseable file to unconfigured', async () => {
    const { fs } = fakeFs({ [FILE]: '{ not json' })
    const store = createOpenCodeServerPasswordStore({
      userDataDir: USER_DATA_DIR,
      fs,
      safeStorage: fakeSafeStorage()
    })
    expect(await store.load()).toEqual({ configured: false })
  })
})

describe('createOpenCodeServerPasswordStore real disk (#588 T6 security fix)', () => {
  // Same real-disk exception `fsAdapter.test.ts`'s `NodeFs` suite and
  // `hookFs.test.ts`'s `NodeHookFs` suite already use: the fake-fs tests above
  // prove the store asks to write ciphertext, this proves the real
  // filesystem actually restricts the resulting file -- wider exposure than
  // the same-user threat model `OpenCodeSettings.vue`'s consent copy names is
  // exactly what a bare `writeFile` with no mode left open under a 022 umask.
  // POSIX-only: Windows has no permission bits for `mode` to set.
  it.skipIf(process.platform === 'win32')('writes the password ciphertext owner-only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwarfai-opencode-password-'))
    try {
      const store = createOpenCodeServerPasswordStore({
        userDataDir: dir,
        safeStorage: fakeSafeStorage()
      })
      expect(await store.save('hunter2')).toEqual({ saved: true })
      const mode = (await stat(join(dir, OPENCODE_PASSWORD_FILE))).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
